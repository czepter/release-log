import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { createHmac } from 'node:crypto';
import { createApp } from './server.ts';
import type { Hooks, Auth } from './server.ts';
import { fileReader } from './lib/store.ts';
import type { Reader } from './lib/store.ts';
import { openDb } from './lib/db/client.ts';
import { account } from './lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { fakeHttp } from './lib/http.ts';
import { createSessionCookie, SESSION_MAX_AGE_SECONDS } from './lib/session.ts';

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
  etag: () => null,
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
  etag: () => null,
};

async function withServer(
  reader: Reader,
  fn: (base: string) => Promise<void>,
  hooks?: Hooks,
  auth?: Auth,
): Promise<void> {
  const server = createApp(reader, hooks, auth);
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
  // server.ts now answers /health itself, ahead of route() (Task 7): the
  // process-liveness shape is { ok: true }, not lib/public.ts's { status:
  // 'ok' } -- that handler is only still reachable by calling route()
  // directly, as lib/public.test.ts does.
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await res.json(), { ok: true });
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
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('a JSON response carries an ETag when the reader has one', async () => {
  const tagged: Reader = { ...reader, etag: () => 'abc0000000000000000000000000000000000def' };
  const server = createApp(tagged);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"abc0000000000000000000000000000000000def"');

    const again = await fetch(`${base}/l/abc123/versions`, {
      headers: { 'if-none-match': '"abc0000000000000000000000000000000000def"' },
    });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), '"abc0000000000000000000000000000000000def"');
    assert.equal((await again.arrayBuffer()).byteLength, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a reader without an etag answers 200 with no ETag header', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), null);
  });
});

test('a stale If-None-Match still gets the body', async () => {
  const tagged: Reader = { ...reader, etag: () => 'aaaa000000000000000000000000000000000000' };
  const server = createApp(tagged);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/l/abc123/versions`, {
      headers: { 'if-none-match': '"something-else"' },
    });
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a private log returns 404 with no ETag header even when the reader has one', async () => {
  const taggedPrivateReader: Reader = { ...privateReader, etag: () => 'abc0000000000000000000000000000000000def' };
  await withServer(taggedPrivateReader, async (base) => {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('etag'), null);
  });
});

test('a non-existent log returns 404 with no ETag header even when the reader has one', async () => {
  const tagged: Reader = { ...reader, etag: () => 'abc0000000000000000000000000000000000def' };
  await withServer(tagged, async (base) => {
    const res = await fetch(`${base}/l/nonexistent/versions`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('etag'), null);
  });
});

const HOOK_SECRET = 'not-the-real-secret';

function signed(body: string, secret = HOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

async function deliver(base: string, event: string, body: string, signature?: string): Promise<Response> {
  const headers: Record<string, string> = { 'x-github-event': event, 'content-type': 'application/json' };
  if (signature !== undefined) headers['x-hub-signature-256'] = signature;
  return fetch(`${base}/webhook`, { method: 'POST', headers, body });
}

test('health answers 200 without touching the reader', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('a signed push is accepted and its repository is handed on', async () => {
  const seen: string[] = [];
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body, signed(body));
      assert.equal(res.status, 202);
      assert.deepEqual(seen, ['o/r']);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: (refs) => { for (const ref of refs) seen.push(`${ref.owner}/${ref.repo}`); } },
  );
});

test('an unsigned delivery is refused and nothing is handed on', async () => {
  let called = false;
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body);
      assert.equal(res.status, 401);
      assert.equal(called, false);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: () => { called = true; } },
  );
});

test('a delivery signed with the wrong secret is refused', async () => {
  let called = false;
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body, signed(body, 'someone-elses-secret'));
      assert.equal(res.status, 401);
      assert.equal(called, false);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: () => { called = true; } },
  );
});

test('a body that is not json is refused after the signature checks out', async () => {
  // The signature checks out, the content is still garbage. This may be 400
  // and must not crash the process.
  let called = false;
  const body = 'not json at all';
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body, signed(body));
      assert.equal(res.status, 400);
      assert.equal(called, false);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: () => { called = true; } },
  );
});

test('an oversized delivery is refused', async () => {
  // Valid JSON, just too large. That's the point: without a size limit this
  // body would sail through and be accepted with 202 -- a test with broken
  // JSON would also pass without the limit, because it would fail at the
  // parser instead of at the limit.
  let handed = -1;
  const body = JSON.stringify({ repository: { full_name: 'o/r' }, pad: 'x'.repeat(2 * 1024 * 1024) });
  await withServer(
    reader,
    async (base) => {
      // The server aborts the connection as soon as the limit falls; depending
      // on how much of the body was already out, the client sees either the
      // 413 or a dropped connection. Both count as "refused".
      const status = await deliver(base, 'push', body, signed(body))
        .then((res) => res.status)
        .catch(() => 0);
      assert.notEqual(status, 202, 'an oversized body must not be accepted');
      assert.ok(status === 413 || status === 0, `unexpected status ${status}`);
      assert.equal(handed, -1, 'and none of it may reach the queue');
    },
    { webhookSecret: HOOK_SECRET, onDelivery: (refs) => { handed = refs.length; } },
  );
});

test('a ping is accepted and names nothing', async () => {
  let refCount = -1;
  const body = JSON.stringify({ zen: 'hi' });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'ping', body, signed(body));
      assert.equal(res.status, 202);
      assert.equal(refCount, 0);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: (refs) => { refCount = refs.length; } },
  );
});

test('without a webhook secret configured the route does not exist', async () => {
  // A service with no secret configured must not be an open trigger.
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(reader, async (base) => {
    const res = await deliver(base, 'push', body, signed(body));
    assert.equal(res.status, 404);
  });
});

const SIGNING_KEY = 'test-signing-key';

function withAuth(fn: (auth: Auth, db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-auth-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_test' } },
    'GET /user': { body: { id: 42, login: 'octocat', avatar_url: 'https://example.test/a.png' } },
  });
  return fn(
    { db, clientId: 'client-id', clientSecret: 'client-secret', signingKey: SIGNING_KEY, adminLogins: ['octocat'], baseUrl: 'https://example.test', http },
    db,
  ).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

// cookieValue above strips everything but the value -- exactly the part
// that can never carry HttpOnly/Secure/SameSite/Max-Age. Those flags only
// ever show up on the RAW Set-Cookie line, so a test that wants to check
// them has to keep the whole line, not the parsed pair.
function rawSetCookie(setCookies: string[], name: string): string | undefined {
  return setCookies.find((line) => line.startsWith(`${name}=`));
}

test('GET /auth/github/login sets a state cookie and redirects with the same state', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location') as string);
      assert.equal(location.origin, 'https://github.com');
      assert.equal(location.pathname, '/login/oauth/authorize');
      assert.equal(location.searchParams.get('client_id'), 'client-id');
      assert.equal(location.searchParams.get('redirect_uri'), 'https://example.test/auth/github/callback');
      const state = location.searchParams.get('state');
      assert.ok(state, 'a state parameter must be present');
      const cookieState = cookieValue(res.headers.getSetCookie(), 'oauth_state');
      assert.equal(cookieState, state);

      // The parsed value alone says nothing about HttpOnly/Secure/SameSite/
      // Max-Age -- those flags only exist on the raw Set-Cookie line, and a
      // string that strips down to `session=${session}; Path=/` would still
      // pass every assertion above this one.
      const rawLine = rawSetCookie(res.headers.getSetCookie(), 'oauth_state');
      assert.ok(rawLine, 'a raw oauth_state Set-Cookie line must be present');
      assert.match(rawLine as string, /HttpOnly/);
      assert.match(rawLine as string, /Secure/);
      assert.match(rawLine as string, /SameSite=Lax/);
      assert.match(rawLine as string, /Max-Age=600/);
    }, undefined, auth);
  });
});

test('two logins in a row get two different states', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const a = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const b = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const stateA = new URL(a.headers.get('location') as string).searchParams.get('state');
      const stateB = new URL(b.headers.get('location') as string).searchParams.get('state');
      assert.notEqual(stateA, stateB);
    }, undefined, auth);
  });
});

test('the callback rejects a state that does not match the cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=wrong`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, auth);
  });
});

test('a successful login for an allowed login sets a session cookie and redirects to /me', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/me');
      const sessionCookie = cookieValue(res.headers.getSetCookie(), 'session');
      assert.ok(sessionCookie, 'a session cookie must be set');

      // Same reasoning as the oauth_state cookie above: the parsed value
      // proves nothing about the security attributes spec §5 names --
      // HttpOnly, Secure, SameSite=Lax, and a Max-Age tied to
      // SESSION_MAX_AGE_SECONDS, not a bare literal that could drift from it.
      const rawLine = rawSetCookie(res.headers.getSetCookie(), 'session');
      assert.ok(rawLine, 'a raw session Set-Cookie line must be present');
      assert.match(rawLine as string, /HttpOnly/);
      assert.match(rawLine as string, /Secure/);
      assert.match(rawLine as string, /SameSite=Lax/);
      assert.match(rawLine as string, new RegExp(`Max-Age=${SESSION_MAX_AGE_SECONDS}`));

      const rows = db.select().from(account).where(eq(account.githubUserId, 42)).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].login, 'octocat');
    }, undefined, auth);
  });
});

test('a successful GitHub identity that is not allowed gets a denial page and no session', async () => {
  await withAuth(async (auth, db) => {
    // octocat is the only admin in this fixture -- swap it out so the
    // login that comes back from the fake is nobody's admin and is not
    // in the allowlist table either.
    const deniedAuth = { ...auth, adminLogins: ['somebody-else'] };
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
      // "Zero trace" means the account row too, not just the cookie -- a
      // denied person must not end up recorded in the database either.
      const rows = db.select().from(account).where(eq(account.githubUserId, 42)).all();
      assert.equal(rows.length, 0);
    }, undefined, deniedAuth);
  });
});

test('a failed token exchange yields a 502 and no session', async () => {
  await withAuth(async (auth) => {
    const brokenHttp = fakeHttp({ 'POST /login/oauth/access_token': { status: 401 } });
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 502);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, { ...auth, http: brokenHttp });
  });
});

test('a network failure during token exchange yields a 502, not a crashed connection', async () => {
  // fakeHttp only ever returns a Response -- it can never reject. A real
  // network failure (fetch throwing, a timeout firing) rejects the promise
  // instead, and that is the shape this test needs to reproduce: a
  // hand-built Http that throws directly.
  const rejectingHttp = async () => { throw new Error('boom'); };
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 502);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, { ...auth, http: rejectingHttp });
  });
});

test('GET /me without a session answers 401', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`);
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('GET /me with a valid session answers with the login and admin flag', async () => {
  await withAuth(async (auth, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-14T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { login: 'octocat', isAdmin: true });
    }, undefined, auth);
  });
});

test('GET /me with a login not in ADMIN_LOGINS answers with isAdmin: false', async () => {
  await withAuth(async (auth, db) => {
    // auth's adminLogins fixture is ['octocat'] -- this account's login is
    // deliberately someone else, so a route that always says isAdmin: true
    // (or derives it any other way than checking ADMIN_LOGINS) gets caught.
    db.insert(account).values({ githubUserId: 7, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-14T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 7);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { login: 'not-an-admin', isAdmin: false });
    }, undefined, auth);
  });
});

test('GET /me with a forged session signature answers 401, not authenticated', async () => {
  await withAuth(async (auth, db) => {
    // A real cookie for a real account -- but with the signature replaced,
    // so this can only pass if the route actually verifies the signature
    // rather than trusting the payload it decodes.
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-14T00:00:00.000Z' }).run();
    const real = createSessionCookie(SIGNING_KEY, 42);
    const forged = `${real.slice(0, real.indexOf('.'))}.not-the-real-signature`;
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { cookie: `session=${forged}` } });
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('GET /me with a session whose account row is gone answers 401, not a throw', async () => {
  await withAuth(async (auth) => {
    const cookie = createSessionCookie(SIGNING_KEY, 999);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('POST /auth/logout clears the session cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/logout`, { method: 'POST' });
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith('session='));
      assert.ok(cleared, 'a session cookie must be sent to clear the old one');
      assert.match(cleared as string, /Max-Age=0/);
    }, undefined, auth);
  });
});

test('without auth configured, the login and /me routes do not exist', async () => {
  await withServer(reader, async (base) => {
    assert.equal((await fetch(`${base}/auth/github/login`, { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${base}/me`)).status, 404);
  });
});

test('a member webhook delivery calls onPermissionInvalidation, not onDelivery', async () => {
  const delivered: unknown[] = [];
  const invalidated: unknown[] = [];
  const body = JSON.stringify({ action: 'added', repository: { full_name: 'o/r' } });
  const secret = 'hook-secret';
  const sig = `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'x-github-event': 'member', 'x-hub-signature-256': sig },
      body,
    });
    assert.equal(res.status, 202);
    assert.deepEqual(delivered, []);
    assert.deepEqual(invalidated, [{ owner: 'o', repo: 'r' }]);
  }, {
    webhookSecret: secret,
    onDelivery: (refs) => { delivered.push(...refs); },
    onPermissionInvalidation: (refs) => { invalidated.push(...refs); },
  });
});
