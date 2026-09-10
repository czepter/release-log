import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHttp, withRetry } from './http.ts';

test('fakeHttp answers a route and records the call', async () => {
  const http = fakeHttp({ 'GET /repos/o/r': { body: { node_id: 'R_1' } } });
  const res = await http('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { node_id: 'R_1' });
  assert.deepEqual(http.calls, ['GET /repos/o/r']);
});

test('fakeHttp answers an unknown route with 404, not a throw', async () => {
  const http = fakeHttp({});
  const res = await http('https://api.github.com/repos/o/gone');
  assert.equal(res.status, 404);
});

test('fakeHttp serves an array of responses in order', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': [{ status: 500 }, { status: 200, body: { ok: true } }],
  });
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 500);
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 200);
});

test('the last response of an array repeats once exhausted', async () => {
  const http = fakeHttp({ 'GET /repos/o/r': [{ status: 500 }] });
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 500);
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 500);
});

test('fakeHttp distinguishes methods on the same path', async () => {
  const http = fakeHttp({
    'GET /app/installations/7/access_tokens': { status: 404 },
    'POST /app/installations/7/access_tokens': { body: { token: 't' } },
  });
  const res = await http('https://api.github.com/app/installations/7/access_tokens', { method: 'POST' });
  assert.deepEqual(await res.json(), { token: 't' });
});

test('the query string is part of the key', async () => {
  const http = fakeHttp({ 'GET /repos/o/r/git/trees/abc?recursive=1': { body: { tree: [] } } });
  const res = await http('https://api.github.com/repos/o/r/git/trees/abc?recursive=1');
  assert.equal(res.status, 200);
});

test('the method is matched case-insensitively, as fetch normalises it', async () => {
  const http = fakeHttp({ 'POST /app/installations/7/access_tokens': { body: { token: 't' } } });
  const res = await http('https://api.github.com/app/installations/7/access_tokens', { method: 'post' });
  assert.deepEqual(await res.json(), { token: 't' });
  assert.deepEqual(http.calls, ['POST /app/installations/7/access_tokens']);
});

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('a 500 is retried and the second answer is returned', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': [{ status: 500 }, { status: 200, body: { ok: true } }] });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.equal(waits.length, 1);
});

test('retries are bounded and the last failure is returned, not thrown', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': [{ status: 500 }] });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { attempts: 3, sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 500);
  assert.equal(waits.length, 2, 'three attempts means two waits');
  // Pins the growth itself, not just the count: a stub that always waits 0ms
  // would satisfy every assertion above.
  assert.deepEqual(waits, [500, 1000], 'backoff must double each attempt from BASE_BACKOFF_MS');
});

test('a 404 is not retried', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': { status: 404 } });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits.length, 0, 'a missing resource will not appear by waiting');
});

test('a 200 is not retried', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': { body: { ok: true } } });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits.length, 0);
});

test('an exhausted rate limit waits until its reset', async () => {
  const now = 1_700_000_000_000;
  const resetAtSeconds = Math.floor(now / 1000) + 30;
  const inner = fakeHttp({
    'GET /repos/o/r': [
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAtSeconds) } },
      { status: 200, body: { ok: true } },
    ],
  });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep, nowMs: () => now })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.ok(waits[0] >= 30_000 && waits[0] <= 31_000, `expected a ~30s wait, got ${waits[0]}`);
});

test('a secondary rate limit (403 with Retry-After) is retried even with quota left', async () => {
  // A secondary rate limit answers 403 with Retry-After while the primary
  // quota is untouched, so x-ratelimit-remaining is not '0'. It must still
  // be retried, honouring Retry-After.
  const inner = fakeHttp({
    'GET /repos/o/r': [
      { status: 403, headers: { 'retry-after': '3', 'x-ratelimit-remaining': '42' } },
      { status: 200, body: { ok: true } },
    ],
  });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.equal(waits[0], 3000, 'must wait the Retry-After duration');
});

test('a 403 that is not a rate limit is not retried', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': { status: 403, headers: { 'x-ratelimit-remaining': '4999' } } });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 403);
  assert.equal(waits.length, 0, 'a permission failure will not resolve itself');
});

test('a 429 honours Retry-After', async () => {
  const inner = fakeHttp({
    'GET /repos/o/r': [{ status: 429, headers: { 'retry-after': '5' } }, { status: 200, body: { ok: true } }],
  });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits[0], 5000);
});

test('a 429 with no Retry-After header waits the fallback, not zero', async () => {
  // headers.get returns null for a missing header, and Number(null) is 0 —
  // a finite, non-negative number that would silently pass as "wait 0ms"
  // if the code ever called Number() on the header before checking for
  // null.
  const inner = fakeHttp({ 'GET /repos/o/r': [{ status: 429 }, { status: 200, body: { ok: true } }] });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits[0], 500, 'must wait BASE_BACKOFF_MS, not 0ms');
});

test('a rate-limited 403 with no reset header waits the fallback, not zero', async () => {
  const inner = fakeHttp({
    'GET /repos/o/r': [
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      { status: 200, body: { ok: true } },
    ],
  });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits[0], 500, 'must wait BASE_BACKOFF_MS, not 0ms');
});

test('a wait longer than the ceiling gives up rather than sleeping for an hour', async () => {
  const now = 1_700_000_000_000;
  const inner = fakeHttp({
    'GET /repos/o/r': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600) } },
  });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep, nowMs: () => now })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 403);
  assert.equal(waits.length, 0, 'an hour-long wait blocks the process; report instead');
});
