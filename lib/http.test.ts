import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHttp } from './http.ts';

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
