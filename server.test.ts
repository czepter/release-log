import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
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
  problems: () => [],
};

// Same shape as `reader` above but private, and media() still resolves the
// blob -- so this test can only pass if server.ts's own visibility check
// stops the response, not because the Reader double has nothing to serve.
const privateReader: Reader = {
  config: (id) => (id === 'abc123'
    ? { id: 'abc123', product: 'Demo', view: 'full', visibility: 'private', curation_notes: null }
    : null),
  releases: () => [],
  media: (id, path) =>
    id === 'abc123' && path === 'media/x.png'
      ? { type: 'image/png', bytes: Buffer.from([1, 2, 3]) }
      : null,
  errors: () => [],
  problems: () => [],
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
  // A release pointing at that same file, for the emit-then-fetch round trip.
  writeFileSync(join(log, 'releases', '1.0.0.json'), JSON.stringify({
    version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
    headline: 'Test release', image: { src: 'media/my file 100%.png', alt: 'a screenshot' },
  }));
  return root;
}

// fixture() writes to a fresh temp dir every call; nothing removes it on its
// own, so a test run leaves growing junk under the OS temp dir. Route every
// fixture-backed test through this so cleanup happens even on failure.
async function withFixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fixture();
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A minimal raw-socket client: node's fetch (and every normal HTTP client)
// refuses to send a malformed request line, so reproducing the crash needs
// a socket that writes bytes verbatim. Collects the response text until the
// server closes the connection (the request declares Connection: close).
function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(requestText));
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('close', () => resolveRequest(data));
    socket.on('error', reject);
  });
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

test('media for a private log is 404 with no cross-origin header, even though the reader has the blob', async () => {
  await withServer(privateReader, async (base) => {
    const res = await fetch(`${base}/l/abc123/media/media/x.png`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
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
  await withFixture(async (root) => {
    await withServer(fileReader(root), async (base) => {
      const res = await fetch(`${base}/l/abc123/media/media/my%20file%20100%25.png`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal((await res.arrayBuffer()).byteLength, 3);
    });
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
  await withFixture(async (root) => {
    await withServer(fileReader(root), async (base) => {
      const res = await fetch(`${base}/l/abc123/media/..%2f..%2fetc%2fhosts`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'not_found' });
    });
  });
});

test('the media URL public.ts emits for a special-character filename is the URL the server serves', async () => {
  // lib/public.ts encodes image.src into a URL; this proves the other half
  // of that contract holds too -- the server can actually serve the URL it
  // was handed, not just decode a hand-written one (Finding 3's round trip).
  await withFixture(async (root) => {
    await withServer(fileReader(root), async (base) => {
      const detailRes = await fetch(`${base}/l/abc123/releases/1.0.0`);
      assert.equal(detailRes.status, 200);
      const body = await detailRes.json() as { image: { src: string } };
      assert.match(body.image.src, /%20/);

      const mediaRes = await fetch(`${base}${body.image.src}`);
      assert.equal(mediaRes.status, 200);
      assert.equal(mediaRes.headers.get('content-type'), 'image/png');
      assert.equal((await mediaRes.arrayBuffer()).byteLength, 3);
    });
  });
});

test('a malformed request target answers 400 and the server survives to serve the next request', async () => {
  await withServer(reader, async (base) => {
    const port = Number(new URL(base).port);
    // "//[/x" passes straight through Node's HTTP parser as req.url (no
    // validation there) and only breaks when the handler builds a URL from
    // it -- the exact shape the reviewer reproduced.
    const response = await rawRequest(
      port,
      'GET //[/x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 400/);
    assert.match(response, /"error":"bad_request"/);

    // The assertion that matters: the process is still alive to answer the
    // next request. A crash from an exception escaping the request listener
    // would kill the whole test run, not just fail a status-code check.
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});
