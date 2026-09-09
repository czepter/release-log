import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.ts';
import { fileReader } from './lib/store.ts';
import type { Reader } from './lib/store.ts';

const reader: Reader = {
  config: (id) => (id === 'abc123'
    ? { id: 'abc123', product: 'Demo', view: 'full', visibility: 'public', curation_notes: null }
    : null),
  releases: () => [],
  media: (id, path) =>
    id === 'abc123' && path === 'media/x.png'
      ? { type: 'image/png', bytes: Buffer.from([1, 2, 3]) }
      : null,
  errors: () => [],
};

async function withServer(reader: Reader, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(reader);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// Real files on disk so the decode tests exercise the actual boundary guard
// in lib/store.ts, not a mock's exact-string match.
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'rlh-server-'));
  const log = join(root, 'demo');
  mkdirSync(join(log, 'releases'), { recursive: true });
  mkdirSync(join(log, 'media'), { recursive: true });
  writeFileSync(join(log, 'release-log.json'), JSON.stringify({
    id: 'abc123', product: 'Demo', view: 'full', visibility: 'public',
  }));
  // A filename with a space AND a literal percent sign: the space is the
  // classic case that only round-trips through percent-encoding, and the
  // percent sign makes the test sensitive to a doubled decode too (see the
  // test below).
  writeFileSync(join(log, 'media', 'my file 100%.png'), Buffer.from([1, 2, 3]));
  return root;
}

test('health answers 200 with JSON', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('a public JSON route allows cross-origin reads', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('media is served with a long immutable cache', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/l/abc123/media/media/x.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await res.arrayBuffer()).byteLength, 3);
  });
});

test('missing media is 404 JSON', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/l/abc123/media/media/nope.png`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });
});

test('a trailing slash resolves to the same route', async () => {
  await withServer(reader, async (base) => {
    assert.equal((await fetch(`${base}/l/abc123/versions/`)).status, 200);
  });
});

test('a media filename with a space is served when requested percent-encoded', async () => {
  // The on-disk file is "my file 100%.png"; encodeURIComponent of that name
  // is "my%20file%20100%25.png". This one request distinguishes all three
  // decode counts:
  //  - zero decodes: server looks for a file literally named
  //    "my%20file%20100%25.png", which does not exist -> 404.
  //  - one decode (correct): becomes "my file 100%.png", which matches the
  //    file on disk -> 200.
  //  - two decodes: decoding "my file 100%.png" again hits "%.p", which is
  //    not a valid percent-escape, so decodeURIComponent throws and the
  //    request 404s instead of serving the file.
  // Only the correct, single decode reaches 200, so this is not vacuous.
  await withServer(fileReader(fixture()), async (base) => {
    const res = await fetch(`${base}/l/abc123/media/media/my%20file%20100%25.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await res.arrayBuffer()).byteLength, 3);
  });
});

test('an encoded path-traversal attempt is refused with 404', async () => {
  // "..%2f..%2fetc%2fhosts" decodes once to the real string "../../etc/hosts",
  // which is what lib/store.ts's boundary guard has to judge and reject
  // (target resolves outside log.dir, so media() returns null). This proves
  // the server hands the guard a genuinely decoded path rather than, say,
  // failing open by skipping the /l/.../media/ route match on encoded input.
  // Paired with the space test above (which fails if the decode is missing),
  // this shows the single decode is exercised without re-opening the path
  // guard it exists to satisfy.
  await withServer(fileReader(fixture()), async (base) => {
    const res = await fetch(`${base}/l/abc123/media/..%2f..%2fetc%2fhosts`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });
});
