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
import { fakeGitHub } from './lib/github.ts';
import type { GitHub, RepoRef } from './lib/github.ts';
import { permissions } from './lib/permissions.ts';
import { log, release, media, allowlist, githubUserToken } from './lib/db/schema.ts';
import { mintTokenPair } from './lib/oauth.ts';
import { mintUploadToken, UPLOAD_TOKEN_TTL_MS } from './lib/uploads.ts';
import { userTokens } from './lib/userTokens.ts';
import { cipher } from './lib/secrets.ts';
import { indexReader } from './lib/indexReader.ts';

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
  const gh = fakeGitHub({});
  return fn(
    {
      db, clientId: 'client-id', clientSecret: 'client-secret', signingKey: SIGNING_KEY,
      adminLogins: ['octocat'], baseUrl: 'https://example.test', http,
      gh, perms: permissions(db, gh), onRepoWrite: () => {},
      // Dieselben Vorgaben wie in lib/mcpTools.test.ts: vorhanden, damit
      // jede Route baut, und wirkungslos, bis ein Test sie ersetzt.
      users: userTokens({
        db, http, cipher: cipher(Buffer.alloc(32, 3)),
        clientId: 'client-id', clientSecret: 'client-secret',
      }),
      createRepo: async () => ({ kind: 'unavailable', status: 503 }),
      syncNow: async () => {},
    },
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
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/anmeldung?fehler=state');
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, auth);
  });
});

test('a successful login for an allowed login sets a session cookie and redirects to the dashboard', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/dashboard');
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

// Entscheidung 23: die Anmeldung ist der einzige Moment, in dem ein
// GitHub-Nutzer-Token entsteht. Es hier wegzuwerfen hieße, create_log nie
// benutzen zu können -- genau der Zustand, den Issue #1 aufhebt.
test('a successful login stores the GitHub user token for that account', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual', headers: { cookie: 'oauth_state=right' },
      });
      // 'gho_test' ist, was die Fixture von GitHub zurückgibt (s. withAuth).
      assert.deepEqual(await auth.users.tokenFor(42), { ok: true, token: 'gho_test' });
      const row = db.select().from(githubUserToken).where(eq(githubUserToken.accountId, 42)).all()[0];
      assert.ok(row, 'the grant must be persisted');
      assert.ok(!row.accessTokenEnc.includes('gho_test'), 'and never in the clear');
    }, undefined, auth);
  });
});

test('a denied login stores no user token either', async () => {
  // „Zero trace" gilt auch hier: das Token entsteht erst hinter der
  // Zulassungsprüfung.
  await withAuth(async (auth, db) => {
    const deniedAuth = { ...auth, adminLogins: ['somebody-else'] };
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual', headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/anmeldung?fehler=denied');
      assert.equal(db.select().from(githubUserToken).all().length, 0);
    }, undefined, deniedAuth);
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
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/anmeldung?fehler=denied');
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
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/anmeldung?fehler=github');
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
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/anmeldung?fehler=github');
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

test('a synchronous throw from the database during the callback answers 500, not a crashed connection', async () => {
  // Reproduces a locked/corrupted sqlite file: isAllowed's db.select() runs
  // for every /auth/github/callback caller, allowlisted or not, before the
  // allowlist decision is even made. Route through a login that is NOT an
  // admin, so isAllowed actually reaches the allowlist table instead of
  // short-circuiting on ADMIN_LOGINS.
  await withAuth(async (auth) => {
    const throwingDb = new Proxy(auth.db, {
      get(target, prop, receiver) {
        if (prop === 'select') return () => { throw new Error('database is locked'); };
        return Reflect.get(target, prop, receiver);
      },
    });
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'internal_error' });

      // The assertion that matters: the process is still alive to answer
      // the next request, exactly like the malformed-request-target test
      // above.
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
    }, undefined, { ...auth, adminLogins: ['somebody-else'], db: throwingDb });
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

function insertLog(db: ReturnType<typeof openDb>, publicId: string, owner: string, repo: string, state = 'active'): void {
  db.insert(log).values({
    publicId, repoOwner: owner, repoName: repo, repoNodeId: `R_${publicId}`,
    product: `Product ${publicId}`, view: 'full', visibility: 'public', curationNotes: null,
    state, headSha: 'c0ffee', configBlobSha: 'abc', indexedAt: '2026-09-15T00:00:00.000Z',
  }).run();
}

test('GET / without auth configured stays 404', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  });
});

test('a frozen log is hidden from a non-admin account without write access', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'frozen-two', 'o', 'gone-repo-2', 'frozen');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      collaboratorPermission: async () => null,
    };
    const cookie = createSessionCookie(SIGNING_KEY, 99);
    db.insert(account).values({ githubUserId: 99, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('Product frozen-two'), 'a frozen log stays hidden from a non-admin who cannot write to it');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /dashboard/logs/:id for an unknown id answers 404', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/does-not-exist`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 404);
    }, undefined, auth);
  });
});

test('a curation_notes value with HTML-meaningful characters is escaped', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: '<img src=x onerror=alert(1)>',
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh = fakeGitHub({ 'o/repo1': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'the raw markup must never appear unescaped');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

async function postForm(base: string, path: string, fields: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `session=${cookie}` },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

const TINY_PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// PUT /upload/<token> -- der Weg, den add_media aufmacht (Issue #2,
// spec §6). Die Erlaubnis wird hier direkt geprägt statt über das Werkzeug:
// was add_media entscheidet, steht in lib/mcpTools.test.ts; hier steht, was
// die Route mit einer fertigen Erlaubnis macht.
function insertUploadableLog(db: ReturnType<typeof openDb>, state = 'active'): void {
  db.insert(log).values({
    publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
    product: 'P', view: 'full', visibility: 'public', curationNotes: null,
    state, headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
  }).run();
  db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
}

const UPLOAD_BINDING = { logId: 'log1', path: 'media/screenshot.png', accountId: 42, contentType: 'image/png' };

async function putUpload(base: string, token: string, bytes: Buffer): Promise<Response> {
  return fetch(`${base}/upload/${token}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
}

test('PUT /upload/<token> commits the bytes under the token\'s path and triggers a resync', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let committed: { path: string; content: Buffer; sha: string | null } | null = null;
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(_ref, path, content, _message, expectedSha) {
        committed = { path, content, sha: expectedSha };
        return { kind: 'committed', sha: 'media-sha' };
      },
    };
    await withServer(reader, async (base) => {
      const res = await putUpload(base, token, TINY_PNG);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true, path: 'media/screenshot.png', content_type: 'image/png', commit_sha: 'media-sha',
      });
      assert.ok(committed, 'putFile must have been called');
      // Der Pfad kommt aus dem Token, nicht aus der Anfrage: der
      // Hochladende bestimmt nur die Bytes.
      assert.equal(committed!.path, 'media/screenshot.png');
      assert.deepEqual(committed!.content, TINY_PNG);
      assert.equal(committed!.sha, null, 'a new media file is created, never an overwrite');
      assert.deepEqual(enqueued, { owner: 'o', repo: 'repo1' });
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('an upload token works exactly once', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let commits = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { commits += 1; return { kind: 'committed', sha: 'media-sha' }; },
    };
    await withServer(reader, async (base) => {
      assert.equal((await putUpload(base, token, TINY_PNG)).status, 200);
      const second = await putUpload(base, token, TINY_PNG);
      assert.equal(second.status, 403);
      assert.equal(((await second.json()) as { error: string }).error, 'invalid_token');
      assert.equal(commits, 1, 'the second attempt must not reach GitHub at all');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an expired upload token is refused', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const longAgo = new Date(Date.now() - UPLOAD_TOKEN_TTL_MS - 1000).toISOString();
    const { token } = mintUploadToken(db, UPLOAD_BINDING, () => longAgo);
    let commits = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { commits += 1; return { kind: 'committed', sha: 'media-sha' }; },
    };
    await withServer(reader, async (base) => {
      const res = await putUpload(base, token, TINY_PNG);
      assert.equal(res.status, 403);
      assert.equal(commits, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an unknown upload token is refused the same way an expired one is', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    await withServer(reader, async (base) => {
      const res = await putUpload(base, 'never-minted-anywhere', TINY_PNG);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_token');
    }, undefined, auth);
  });
});

test('an upload by an account that lost write access in the meantime is refused', async () => {
  // Die Erlaubnis wurde ausgestellt, als das Konto schreiben durfte. Sie
  // gilt zehn Minuten -- die Rechteprüfung gilt bis zum Commit (spec §5:
  // GitHub entscheidet, live, nicht das ausgestellte Papier).
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let commits = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read',
      async putFile() { commits += 1; return { kind: 'committed', sha: 'media-sha' }; },
    };
    await withServer(reader, async (base) => {
      const res = await putUpload(base, token, TINY_PNG);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, 'forbidden');
      assert.equal(commits, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an upload to a log that froze after the token was issued is refused', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db, 'frozen');
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let commits = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => null,
      async putFile() { commits += 1; return { kind: 'committed', sha: 'media-sha' }; },
    };
    await withServer(reader, async (base) => {
      const res = await putUpload(base, token, TINY_PNG);
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: string }).error, 'log_frozen');
      assert.equal(commits, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an oversized upload is refused with 413 and never reaches GitHub', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let commits = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { commits += 1; return { kind: 'committed', sha: 'media-sha' }; },
    };
    await withServer(reader, async (base) => {
      const status = await putUpload(base, token, Buffer.alloc(11 * 1024 * 1024))
        .then((res) => res.status)
        .catch(() => 0);
      assert.notEqual(status, 200);
      assert.ok(status === 413 || status === 0, `unexpected status ${status}`);
      assert.equal(commits, 0, 'an oversized body must never reach putFile');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GitHub refusing the path (it already exists) comes back as path_exists', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'conflict' }; },
    };
    await withServer(reader, async (base) => {
      const res = await putUpload(base, token, TINY_PNG);
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: string }).error, 'path_exists');
      assert.equal(enqueued, null, 'nothing was committed, so nothing needs resyncing');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('an empty upload body is refused before any commit', async () => {
  await withAuth(async (auth, db) => {
    insertUploadableLog(db);
    const { token } = mintUploadToken(db, UPLOAD_BINDING);
    let commits = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { commits += 1; return { kind: 'committed', sha: 'media-sha' }; },
    };
    await withServer(reader, async (base) => {
      const res = await putUpload(base, token, Buffer.alloc(0));
      assert.equal(res.status, 400);
      assert.equal(commits, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an allowlist login containing HTML-meaningful characters is escaped', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: '<script>x</script>', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>x</script>'));
    }, undefined, auth);
  });
});

test('an allowlist note containing HTML-meaningful characters is escaped', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: '<img src=x>' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<img src=x>'));
    }, undefined, auth);
  });
});

test('an allowlist addedBy containing HTML-meaningful characters is escaped', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: '<script>admin</script>', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>admin</script>'));
    }, undefined, auth);
  });
});

test('POST /oauth/register with a valid redirect_uri returns 201 and a client_id', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/cb'], client_name: 'Test' }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as { client_id: string; token_endpoint_auth_method: string };
      assert.ok(typeof body.client_id === 'string' && body.client_id.length > 0);
      assert.equal(body.token_endpoint_auth_method, 'none');
    }, undefined, auth);
  });
});

test('POST /oauth/register without redirect_uris returns 400', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    }, undefined, auth);
  });
});

test('POST /oauth/register is rate-limited after 10 requests from the same IP', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${base}/oauth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
        });
        assert.equal(res.status, 201, `request ${i + 1} of 10 must succeed`);
      }
      const eleventh = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
      });
      assert.equal(eleventh.status, 429);
    }, undefined, auth);
  });
});

test('GET /auth/github/login with next=/oauth/authorize?... stores it in a cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/login?next=${encodeURIComponent('/oauth/authorize?client_id=abc')}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
      const loginNext = setCookies.find((c) => c.startsWith('login_next='));
      assert.ok(loginNext, 'login_next cookie must be set');
      assert.ok(loginNext!.includes(encodeURIComponent('/oauth/authorize?client_id=abc')));
    }, undefined, auth);
  });
});

test('GET /auth/github/login with a next that is not /oauth/authorize is ignored, no cookie set', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/login?next=${encodeURIComponent('https://evil.example/steal')}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
      assert.equal(setCookies.some((c) => c.startsWith('login_next=')), false, 'an out-of-scope next must never reach a cookie');
    }, undefined, auth);
  });
});

test('a successful callback redirects to the stored login_next instead of /me, and clears the cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const loginRes = await fetch(`${base}/auth/github/login?next=${encodeURIComponent('/oauth/authorize?client_id=abc')}`, { redirect: 'manual' });
      const setCookies = loginRes.headers.getSetCookie?.() ?? [];
      const stateCookie = setCookies.find((c) => c.startsWith('oauth_state='))!.split(';')[0];
      const nextCookie = setCookies.find((c) => c.startsWith('login_next='))!.split(';')[0];
      const state = stateCookie.split('=')[1];

      const cbRes = await fetch(`${base}/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual', headers: { cookie: `${stateCookie}; ${nextCookie}` },
      });
      assert.equal(cbRes.status, 302);
      assert.equal(cbRes.headers.get('location'), '/oauth/authorize?client_id=abc');
      const cbSetCookies = cbRes.headers.getSetCookie?.() ?? [];
      assert.ok(cbSetCookies.some((c) => c.startsWith('login_next=;') || c.startsWith('login_next=; ')), 'login_next must be cleared after use');
    }, undefined, auth);
  });
});

test('a callback with no login_next cookie redirects to the dashboard (the default)', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const loginRes = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const setCookies = loginRes.headers.getSetCookie?.() ?? [];
      const stateCookie = setCookies.find((c) => c.startsWith('oauth_state='))!.split(';')[0];
      const state = stateCookie.split('=')[1];
      const cbRes = await fetch(`${base}/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual', headers: { cookie: stateCookie },
      });
      assert.equal(cbRes.headers.get('location'), '/dashboard');
    }, undefined, auth);
  });
});

async function registerTestClient(base: string, redirectUri = 'https://client.example/cb', clientName = 'Test Client'): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: clientName }),
  });
  const body = await res.json() as { client_id: string };
  return body.client_id;
}

const AUTHORIZE_CHALLENGE = 'X_sK_G4Dyklp20kbAx-LJ1PgccfIg7q9182mvWIO9U0'; // s. Task 2/6

test('POST /oauth/authorize with decision=allow redirects to redirect_uri with a code and the original state', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const res = await postForm(base, '/oauth/authorize', {
        decision: 'allow', client_id: clientId, redirect_uri: 'https://client.example/cb',
        code_challenge: AUTHORIZE_CHALLENGE, code_challenge_method: 'S256', state: 'xyz', scope: 'logs:read',
      }, cookie);
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.origin + location.pathname, 'https://client.example/cb');
      assert.ok(location.searchParams.get('code'));
      assert.equal(location.searchParams.get('state'), 'xyz');
    }, undefined, auth);
  });
});

test('POST /oauth/authorize with decision=deny redirects with access_denied, no code issued', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const res = await postForm(base, '/oauth/authorize', {
        decision: 'deny', client_id: clientId, redirect_uri: 'https://client.example/cb',
        code_challenge: AUTHORIZE_CHALLENGE, code_challenge_method: 'S256', state: 'xyz', scope: 'logs:read',
      }, cookie);
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'access_denied');
      assert.equal(location.searchParams.get('code'), null);
    }, undefined, auth);
  });
});

async function postFormRaw(base: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function authorizeAndGetCode(base: string, cookie: string, clientId: string): Promise<{ code: string; state: string }> {
  const res = await postForm(base, '/oauth/authorize', {
    decision: 'allow', client_id: clientId, redirect_uri: 'https://client.example/cb',
    code_challenge: AUTHORIZE_CHALLENGE, code_challenge_method: 'S256', state: 'xyz', scope: 'logs:read',
  }, cookie);
  const location = new URL(res.headers.get('location')!);
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

const AUTHORIZE_VERIFIER = 'test-verifier-12345678901234567890123456789'; // s. Task 2

test('POST /oauth/token exchanges a valid code for an access and refresh token', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);

      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { access_token: unknown; refresh_token: unknown; token_type: string; expires_in: number };
      assert.ok(typeof body.access_token === 'string' && body.access_token.length > 0);
      assert.ok(typeof body.refresh_token === 'string' && body.refresh_token.length > 0);
      assert.equal(body.token_type, 'Bearer');
      assert.equal(body.expires_in, 3600);
    }, undefined, auth);
  });
});

// Issue #4: ein code_verifier, der RFC 7636 §4.1 verfehlt (hier: zu kurz),
// wird als ungültige Einlösung abgewiesen, nicht erst als Hash-Mismatch --
// derselbe invalid_grant nach außen, aber der Grund steht jetzt an der
// Grenze und nicht im Vergleich.
test('POST /oauth/token with a malformed code_verifier is refused', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      // Der Code wird mit der Challenge des 39-Zeichen-Verifiers geprägt,
      // und eingelöst wird genau mit diesem Verifier: Hash und Challenge
      // passen zusammen, nur die Form nicht. Ohne die Formprüfung ginge
      // dieser Tausch durch -- er ist also kein Test, der ohnehin scheitert.
      const shortVerifier = 'test-verifier-1234567890123456789012345';
      const authorized = await postForm(base, '/oauth/authorize', {
        decision: 'allow', client_id: clientId, redirect_uri: 'https://client.example/cb',
        code_challenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8', code_challenge_method: 'S256',
        state: 'xyz', scope: 'logs:read',
      }, cookie);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: shortVerifier,
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_grant' });
    }, undefined, auth);
  });
});

test('POST /oauth/token with a wrong code_verifier is refused', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: 'wrong-verifier-9999999999999999999999999999',
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'invalid_grant');
    }, undefined, auth);
  });
});

test('POST /oauth/token with an unsupported grant_type is refused', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await postFormRaw(base, '/oauth/token', { grant_type: 'password' });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'unsupported_grant_type');
    }, undefined, auth);
  });
});

test('POST /oauth/token is rate-limited after 60 requests from the same IP within a minute', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      for (let i = 0; i < 60; i++) {
        const res = await postFormRaw(base, '/oauth/token', { grant_type: 'password' });
        assert.notEqual(res.status, 429, `request ${i + 1} of 60 must not be rate-limited yet`);
      }
      const res61 = await postFormRaw(base, '/oauth/token', { grant_type: 'password' });
      assert.equal(res61.status, 429);
    }, undefined, auth);
  });
});

test('POST /oauth/token with grant_type=refresh_token exchanges a live refresh token for a new pair', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      const firstRes = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      const first = await firstRes.json() as { access_token: string; refresh_token: string };

      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'refresh_token', refresh_token: first.refresh_token,
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
      assert.ok(typeof body.access_token === 'string' && body.access_token.length > 0);
      assert.ok(typeof body.refresh_token === 'string' && body.refresh_token.length > 0);
      assert.notEqual(body.access_token, first.access_token, 'rotation must mint a new access token');
      assert.notEqual(body.refresh_token, first.refresh_token, 'rotation must mint a new refresh token');
      assert.equal(body.token_type, 'Bearer');
      assert.equal(body.scope, 'logs:read');
    }, undefined, auth);
  });
});

test('POST /oauth/token with grant_type=refresh_token and an unknown refresh token is refused', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'refresh_token', refresh_token: 'not-a-real-token',
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'invalid_grant');
    }, undefined, auth);
  });
});

test('GET /dashboard/connections escapes an HTML-meaningful client name', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base, 'https://client.example/cb', '<script>x</script>');
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      const res = await fetch(`${base}/dashboard/connections`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>x</script>'), 'a client_name with HTML-meaningful characters must be escaped');
    }, undefined, auth);
  });
});

test('POST /mcp without a bearer token answers 401 with a WWW-Authenticate challenge', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      assert.equal(res.status, 401);
      assert.ok(res.headers.get('www-authenticate')?.includes('Bearer'));
    }, undefined, auth);
  });
});

test('POST /mcp with an unknown bearer token answers 401', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('POST /mcp with a valid bearer token reaches the MCP handler', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${pair.accessToken}` },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'initialize', id: 1,
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        }),
      });
      // Not 401/404: the request passed the bearer gate and reached the SDK,
      // whatever the SDK's own answer to a handshake looks like.
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 404);
    }, undefined, auth);
  });
});

test('GET /.well-known/oauth-authorization-server serves RFC 8414 metadata naming this server\'s endpoints', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 200);
      const body = await res.json() as { issuer: string; token_endpoint: string; code_challenge_methods_supported: string[] };
      assert.equal(body.issuer, 'https://example.test');
      assert.equal(body.token_endpoint, 'https://example.test/oauth/token');
      assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    }, undefined, auth);
  });
});

function insertPrivateLogWithDraft(db: ReturnType<typeof openDb>): void {
  db.insert(log).values({
    publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
    view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
    configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
  }).run();
  db.insert(release).values({
    logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: '2026-09-01T00:00:00.000Z', blobSha: 'r1',
    path: 'releases/1.0.0.json', doc: JSON.stringify({
      version: '1.0.0', tag: null, date: '2026-09-01', published_at: '2026-09-01T00:00:00.000Z', commits: 1,
      headline: 'released', body: [], image: null, covered: [], changes: [],
    }),
  }).run();
  db.insert(release).values({
    logId: 'log1', version: '2.0.0-draft', date: '2026-09-14', publishedAt: null, blobSha: 'r2',
    path: 'releases/2.0.0-draft.json', doc: JSON.stringify({
      version: '2.0.0-draft', tag: null, date: '2026-09-14', published_at: null, commits: 1,
      headline: 'unreleased', body: [], image: null, covered: [], changes: [],
    }),
  }).run();
}

test('GET /l/<id>/versions on a private log answers 404 to an anonymous request (unchanged)', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    // These three tests exercise the db-backed log they just inserted, so the
    // JSON route needs the db-backed reader (same wiring as production's
    // createApp(indexReader(db), ...)) -- not the file-fixture `reader`
    // above, which only knows 'abc123'.
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/versions`);
      assert.equal(res.status, 404);
    }, undefined, auth);
  });
});

test('GET /l/<id>/versions with a session that has write access includes the draft', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'write' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/versions`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const body = await res.json() as { versions: unknown[] };
      assert.equal(body.versions.length, 2, 'both the published and the draft version must be listed for a write-access holder');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /l/<id>/versions with a session that has NO write access still hides the draft', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'read' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      // Private + no write access: still a 404, indistinguishable from
      // "does not exist" (spec §7) -- read-only collaboration does not
      // unlock a private log's JSON either.
      const res = await fetch(`${base}/l/log1/versions`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 404);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /l/<id> on a private log is 404 to an anonymous request', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1`);
      assert.equal(res.status, 404);
    }, undefined, auth);
  });
});

// Issue #3: die Medienroute prüfte nur config.visibility === 'public' und
// ließ damit die Bilder eines privaten Logs für JEDEN verschwinden -- auch
// für das angemeldete Mitglied, das dessen Entwürfe ohnehin zu sehen
// bekommt. Diese zwei Tests stehen zusammen: derselbe private Log, dasselbe
// Bild, einmal anonym (404, wie bisher) und einmal mit Schreibrecht (200).
// Nur zusammen unterscheiden sie "Regel richtig" von "Regel weg".
test('media of a private log is served to a signed-in write-access member', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    db.insert(media).values({
      logId: 'log1', path: 'media/x.png', blobSha: 'm1', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]),
    }).run();
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'write' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/media/media/x.png`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal((await res.arrayBuffer()).byteLength, 3);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('media of a private log served to a member is never publicly cacheable', async () => {
  // Die Antwort hängt an der Session, nicht am Pfad: mit dem
  // öffentlichen Ein-Jahr-immutable-Header könnte ein geteilter Cache die
  // Bytes eines privaten Logs an jeden weiterreichen.
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    db.insert(media).values({
      logId: 'log1', path: 'media/x.png', blobSha: 'm1', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]),
    }).run();
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'write' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/media/media/x.png`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const cacheControl = res.headers.get('cache-control') ?? '';
      assert.ok(!cacheControl.includes('public'), `expected a non-public cache-control, got "${cacheControl}"`);
      assert.ok(!cacheControl.includes('immutable'), `expected no immutable cache-control, got "${cacheControl}"`);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('media of a private log stays 404 for a signed-in account without write access', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    db.insert(media).values({
      logId: 'log1', path: 'media/x.png', blobSha: 'm1', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]),
    }).run();
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'read' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/media/media/x.png`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('media of a public log keeps its long immutable cache for everyone', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(media).values({
      logId: 'log1', path: 'media/x.png', blobSha: 'm1', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]),
    }).run();
    const reader = indexReader(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/media/media/x.png`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    }, undefined, auth);
  });
});

