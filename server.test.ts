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
import { log, syncError, release, media, repoPermission, allowlist } from './lib/db/schema.ts';
import { mintTokenPair } from './lib/oauth.ts';
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

test('GET /dashboard without a session redirects to login', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/auth/github/login');
    }, undefined, auth);
  });
});

test('GET /dashboard lists only logs the account can write to', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'writable', 'o', 'writable-repo');
    insertLog(db, 'not-writable', 'o', 'other-repo');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      async collaboratorPermission(ref) { return ref.repo === 'writable-repo' ? 'write' : 'read'; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Product writable'), 'a writable log must be listed');
      assert.ok(!html.includes('Product not-writable'), 'a log without write access must not be listed');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a frozen log is listed for an admin even without canWrite', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'frozen-one', 'o', 'gone-repo', 'frozen');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      collaboratorPermission: async () => null, // a gone repo answers null -- never write access
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      // 'octocat' is this fixture's admin (see withAuth's adminLogins).
      assert.ok(html.includes('Product frozen-one'), 'an admin must still see a frozen log, to reach its delete action');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
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

test('a product name containing HTML-meaningful characters is escaped in the list', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'xss-log', repoOwner: 'o', repoName: 'xss-repo', repoNodeId: 'R_xss',
      product: '<script>alert(1)</script>', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'abc', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh = fakeGitHub({ 'o/xss-repo': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw tag must never appear unescaped');
      assert.ok(html.includes('&lt;script&gt;'), 'it must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a repoOwner and repoName containing HTML-meaningful characters are each escaped independently', async () => {
  await withAuth(async (auth, db) => {
    // Two distinct tags, not one shared value: if only one of the two
    // escapeHtml calls in the row template were ever dropped, a shared
    // fixture could still pass by coincidence. Distinct values make each
    // field's escaping provable on its own.
    insertLog(db, 'xss-owner-repo', '<b>owner</b>', '<i>repo</i>');
    const gh = fakeGitHub({ '<b>owner</b>/<i>repo</i>': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<b>owner</b>'), 'the raw repoOwner tag must never appear unescaped');
      assert.ok(!html.includes('<i>repo</i>'), 'the raw repoName tag must never appear unescaped');
      assert.ok(html.includes('&lt;b&gt;owner&lt;/b&gt;'), 'repoOwner must appear escaped instead');
      assert.ok(html.includes('&lt;i&gt;repo&lt;/i&gt;'), 'repoName must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /dashboard/logs/:id without write access answers 403', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'log1', 'o', 'repo1');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }), collaboratorPermission: async () => 'read',
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 403);
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

test('a frozen log detail page is reachable by an admin even without canWrite', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'frozen-detail', 'o', 'gone-repo-3', 'frozen');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      collaboratorPermission: async () => null, // a gone repo answers null -- never write access
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    // 'octocat' is this fixture's admin (see withAuth's adminLogins).
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/frozen-detail`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Product frozen-detail'), 'an admin must still reach a frozen log\'s own detail page');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /dashboard/logs/:id with write access shows settings, sync status and errors', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'timeline', visibility: 'private', curationNotes: 'internal notes',
      state: 'active', headSha: 'c0ffee', configBlobSha: 'config-sha-1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(syncError).values({ logId: 'log1', path: 'releases/bad.json', message: 'sha:deadbeef date: required', at: '2026-09-15T00:00:00.000Z' }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }), collaboratorPermission: async () => 'admin',
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Auri CRM'));
      assert.ok(html.includes('value="internal notes"') || html.includes('>internal notes<'), 'curation_notes must be pre-filled');
      assert.ok(html.includes('releases/bad.json'), 'the sync error path must be listed');
      assert.ok(html.includes('date: required'), 'the sync error message must be listed');
      assert.ok(html.includes('config-sha-1'), 'the current config blob sha must be embedded for the settings form to submit against');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
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

test('a sync error path and message containing HTML-meaningful characters are each escaped independently', async () => {
  await withAuth(async (auth, db) => {
    // Distinct tags per field, same as the repoOwner/repoName pair on the
    // dashboard list: a shared fixture value could pass by coincidence if
    // only one of the two escapeHtml calls in the error row template were
    // ever dropped.
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(syncError).values({ logId: 'log1', path: '<b>bad/path</b>', message: '<i>bad message</i>', at: '2026-09-15T00:00:00.000Z' }).run();
    const gh = fakeGitHub({ 'o/repo1': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<b>bad/path</b>'), 'the raw path tag must never appear unescaped');
      assert.ok(!html.includes('<i>bad message</i>'), 'the raw message tag must never appear unescaped');
      assert.ok(html.includes('&lt;b&gt;bad/path&lt;/b&gt;'), 'the path must appear escaped instead');
      assert.ok(html.includes('&lt;i&gt;bad message&lt;/i&gt;'), 'the message must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('product, repoOwner, repoName and configBlobSha are each escaped independently on the log page', async () => {
  await withAuth(async (auth, db) => {
    // /dashboard/logs/:id is a separate route with its own template literal
    // from the /dashboard list -- it calls the same escapeHtml function, but
    // that is not the same as sharing a call site. Four distinct tag pairs,
    // one per field, so the test can tell which escapeHtml call was dropped
    // if only one of the four ever is.
    db.insert(log).values({
      publicId: 'log1', repoOwner: '<i>owner-x</i>', repoName: '<u>repo-x</u>', repoNodeId: 'R_log1',
      product: '<b>Odd Product</b>', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: '<s>sha-x</s>', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh = fakeGitHub({ '<i>owner-x</i>/<u>repo-x</u>': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<b>Odd Product</b>'), 'the raw product tag must never appear unescaped');
      assert.ok(!html.includes('<i>owner-x</i>'), 'the raw repoOwner tag must never appear unescaped');
      assert.ok(!html.includes('<u>repo-x</u>'), 'the raw repoName tag must never appear unescaped');
      assert.ok(!html.includes('<s>sha-x</s>'), 'the raw configBlobSha tag must never appear unescaped');
      assert.ok(html.includes('&lt;b&gt;Odd Product&lt;/b&gt;'), 'product must appear escaped instead');
      assert.ok(html.includes('&lt;i&gt;owner-x&lt;/i&gt;'), 'repoOwner must appear escaped instead');
      assert.ok(html.includes('&lt;u&gt;repo-x&lt;/u&gt;'), 'repoName must appear escaped instead');
      assert.ok(html.includes('&lt;s&gt;sha-x&lt;/s&gt;'), 'configBlobSha must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('the log detail page lists releases, distinguishing published from draft', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({ logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: '2026-09-02T00:00:00.000Z', blobSha: 'r1', path: 'releases/1.0.0.json', doc: '{}' }).run();
    db.insert(release).values({ logId: 'log1', version: '2.0.0-rc', date: '2026-09-10', publishedAt: null, blobSha: 'r2', path: 'releases/2.0.0-rc.json', doc: '{}' }).run();
    const gh = fakeGitHub({ 'o/repo1': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(html.includes('1.0.0'), 'the published release version must be listed');
      assert.ok(html.includes('2.0.0-rc'), 'the draft release version must be listed');
      assert.ok(html.includes('Veröffentlicht'), 'a release with publishedAt set must be marked published');
      assert.ok(html.includes('Entwurf'), 'a release with publishedAt null must be marked as a draft');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a release version and date containing HTML-meaningful characters are escaped on the log page', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({ logId: 'log1', version: '<b>1.0.0</b>', date: '<i>2026-09-01</i>', publishedAt: null, blobSha: 'r1', path: 'releases/1.0.0.json', doc: '{}' }).run();
    const gh = fakeGitHub({ 'o/repo1': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<b>1.0.0</b>'), 'the raw version tag must never appear unescaped');
      assert.ok(!html.includes('<i>2026-09-01</i>'), 'the raw date tag must never appear unescaped');
      assert.ok(html.includes('&lt;b&gt;1.0.0&lt;/b&gt;'), 'version must appear escaped instead');
      assert.ok(html.includes('&lt;i&gt;2026-09-01&lt;/i&gt;'), 'date must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('the log detail page shows "keine Installation" (not "erreichbar") when probe reports no_installation', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'no_installation' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(html.includes('keine Installation'), 'a no_installation probe result must be labelled as such');
      assert.ok(!html.includes('erreichbar'), 'a no_installation probe result must not be mislabelled as reachable');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('the log detail page shows "Repo nicht mehr auffindbar" when probe reports gone', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(html.includes('Repo nicht mehr auffindbar'), 'a gone probe result must be labelled as such');
      assert.ok(!html.includes('erreichbar'), 'a gone probe result must not be mislabelled as reachable');
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

test('POST settings commits the new values and redirects back to the log page', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'config-sha-1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committed: { path: string; content: string; sha: string | null } | null = null;
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content, message, expectedSha) {
        committed = { path, content: content.toString('utf8'), sha: expectedSha };
        return { kind: 'committed', sha: 'new-sha' };
      },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'config-sha-1', view: 'timeline', visibility: 'private', curation_notes: 'be careful',
      }, cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/dashboard/logs/log1');
      assert.ok(committed, 'putFile must have been called');
      assert.equal(committed!.path, 'release-log.json');
      assert.equal(committed!.sha, 'config-sha-1');
      const parsed = JSON.parse(committed!.content);
      assert.deepEqual(parsed, { id: 'log1', product: 'Auri CRM', view: 'timeline', visibility: 'private', curation_notes: 'be careful' });
      assert.deepEqual(enqueued, { owner: 'o', repo: 'repo1' }, 'a successful commit must trigger an immediate resync');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('an empty curation_notes becomes null in the committed document, not an empty string', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: 'old notes',
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committedContent = '';
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content) { committedContent = content.toString('utf8'); return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'full', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(JSON.parse(committedContent).curation_notes, null);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

// The route builds `candidate` from the row's own id/product, never from the
// form -- but nothing else pins that down. A future edit that spread form
// fields into the candidate (e.g. to "generalize" it) would let anyone with
// write access to a log's repo rewrite that log's own id (the public URL
// and index lookup key) or its displayed product via a forged POST field,
// and ship it as a real commit.
test('a forged id or product in the form is ignored, not committed', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committedContent = '';
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content) { committedContent = content.toString('utf8'); return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'full', visibility: 'public', curation_notes: '',
        id: 'hijacked-id', product: 'Hijacked Product',
      }, cookie);
      const doc = JSON.parse(committedContent);
      assert.equal(doc.id, 'log1');
      assert.equal(doc.product, 'Auri CRM');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

// putFile returning no_installation must never be treated as success: the
// GitHub installation cannot currently reach this repo, so nothing was
// written. Falling through to onRepoWrite + a 302 would tell the user it
// saved, enqueue a resync for a write that never happened, and silently
// lose the change -- exactly the failure mode this task's design exists to
// prevent for the "committed" and "conflict" outcomes.
test('putFile reporting no_installation answers 502 and enqueues nothing', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'no_installation' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'full', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 502);
      assert.equal(enqueued, null, 'a write that never happened must not trigger a resync enqueue');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('an invalid view value is rejected before anything is committed', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'not-a-real-view', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 400);
      assert.equal(called, false, 'an invalid document must never reach putFile');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a stale expected_sha results in a conflict page, not a silent overwrite', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'current-sha', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'conflict' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'a-now-stale-sha', view: 'full', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 409);
      assert.equal(enqueued, null, 'a conflict must not trigger a resync enqueue');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('a settings change without write access is refused with 403 and commits nothing', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'timeline', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 403);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

async function postBytes(base: string, path: string, bytes: Buffer, filename: string, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': encodeURIComponent(filename), cookie: `session=${cookie}` },
    body: bytes,
  });
}

const TINY_PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('POST media commits the file under media/<filename> and triggers a resync', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committed: { path: string; content: Buffer; sha: string | null } | null = null;
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content, message, expectedSha) {
        committed = { path, content, sha: expectedSha };
        return { kind: 'committed', sha: 'media-sha' };
      },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'screenshot.png', cookie);
      assert.equal(res.status, 200);
      assert.ok(committed, 'putFile must have been called');
      assert.equal(committed!.path, 'media/screenshot.png');
      assert.deepEqual(committed!.content, TINY_PNG);
      assert.equal(committed!.sha, null, 'a new media file must be created, not replace an unrelated sha');
      assert.deepEqual(enqueued, { owner: 'o', repo: 'repo1' });
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('a filename with an unsupported extension is rejected before any commit', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', Buffer.from('not really an svg'), 'shot.svg', cookie);
      assert.equal(res.status, 415);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a filename that is not a bare name (contains a path separator) is rejected', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, '../../etc/passwd.png', cookie);
      assert.equal(res.status, 400);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an oversized upload is refused without buffering the whole body', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    // Strengthened past the brief: prove the size limit doesn't merely
    // answer the wrong status but that it also never lets the oversized
    // body reach putFile — a limit that short-circuits the HTTP response
    // but still commits garbage would pass a status-only assertion.
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    await withServer(reader, async (base) => {
      const status = await postBytes(base, '/dashboard/logs/log1/media', oversized, 'huge.png', cookie)
        .then((res) => res.status)
        .catch(() => 0);
      assert.notEqual(status, 200);
      assert.ok(status === 413 || status === 0, `unexpected status ${status}`);
      assert.equal(called, false, 'an oversized body must never reach putFile');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a media upload without write access is refused with 403', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'shot.png', cookie);
      assert.equal(res.status, 403);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a media upload with no x-filename header at all is rejected before any commit', async () => {
  // A forged request could simply omit the header instead of sending a
  // crafted one. String(undefined ?? '') collapses to '', which must hit
  // the same empty-name rejection as an explicit empty string -- proving
  // that, not just that *some* 4xx comes back, since 415 and 400 are both
  // plausible-looking wrong answers for a missing header.
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1/media`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', cookie: `session=${cookie}` },
        body: TINY_PNG,
      });
      assert.equal(res.status, 400);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a mixed-case extension is accepted and the filename is committed byte-for-byte, case preserved', async () => {
  // mediaTypeOf lowercases the extension before comparing, so ".PNG" must
  // still pass -- and the path it commits under must keep the filename
  // exactly as submitted, not a normalized-case rewrite. Without this,
  // a regression that started rejecting (or silently lower-casing) mixed
  // case would ship unnoticed: none of the other tests use an uppercase
  // extension.
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committed: { path: string; content: Buffer } | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content) {
        committed = { path, content };
        return { kind: 'committed', sha: 'x' };
      },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'Screenshot.PNG', cookie);
      assert.equal(res.status, 200);
      assert.ok(committed, 'putFile must have been called');
      assert.equal(committed!.path, 'media/Screenshot.PNG');
      assert.deepEqual(committed!.content, TINY_PNG);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a media upload hitting a path conflict answers 409 and enqueues nothing', async () => {
  // Mirrors the settings route's own conflict test (Task 5): the two write
  // routes share the same CommitResult shape, so a regression that fires
  // onRepoWrite before checking the branch must be caught on both, not
  // just one.
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'conflict' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'screenshot.png', cookie);
      assert.equal(res.status, 409);
      assert.equal(enqueued, null, 'a conflict must not trigger a resync enqueue');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('a media upload reporting no_installation answers 502 and enqueues nothing', async () => {
  // Mirrors the settings route's own no_installation test (Task 5); see
  // the comment above for why this branch needs its own coverage here too.
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'no_installation' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'screenshot.png', cookie);
      assert.equal(res.status, 502);
      assert.equal(enqueued, null, 'a write that never happened must not trigger a resync enqueue');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('the log page renders the media upload button and file input', async () => {
  // No prior test touched the Task-6 inline-script markup at all -- this
  // just proves it renders, the same shallow html.includes(...) check the
  // settings-form fields already get on this same page.
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }), collaboratorPermission: async () => 'write',
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('id="media-file"'), 'the file input must render');
      assert.ok(html.includes('id="media-submit"'), 'the upload button must render');
      assert.ok(html.includes('/dashboard/logs/log1/media'), 'the upload script must target this log\'s media route');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a malformed percent-sequence in x-filename answers 400, not a crash', async () => {
  // decodeURIComponent throws on an unpaired/invalid %-escape (e.g. a lone
  // "%"). The route wraps that in try/catch and answers 400 -- nothing
  // previously sent input malformed enough to exercise that catch block.
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1/media`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-filename': '%zz.png', cookie: `session=${cookie}` },
        body: TINY_PNG,
      });
      assert.equal(res.status, 400);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('POST delete with the correct name wipes the log, its releases, media, errors and permission cache', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({ logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'r1', path: 'releases/1.0.0.json', doc: '{}' }).run();
    db.insert(media).values({ logId: 'log1', path: 'media/x.png', blobSha: 'm1', contentType: 'image/png', bytes: Buffer.from([1]) }).run();
    db.insert(syncError).values({ logId: 'log1', path: 'releases/bad.json', message: 'x', at: '2026-09-15T00:00:00.000Z' }).run();
    db.insert(repoPermission).values({ accountId: 42, logId: 'log1', canWrite: true, checkedAt: '2026-09-15T00:00:00.000Z' }).run();
    // Add a second log to prove deletion is scoped to logId, not a blanket table wipe
    db.insert(log).values({
      publicId: 'log2', repoOwner: 'o2', repoName: 'repo2', repoNodeId: 'R_log2',
      product: 'Other Product', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'beef', configBlobSha: 'sha2', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({ logId: 'log2', version: '2.0.0', date: '2026-09-02', publishedAt: null, blobSha: 'r2', path: 'releases/2.0.0.json', doc: '{}' }).run();
    db.insert(media).values({ logId: 'log2', path: 'media/y.png', blobSha: 'm2', contentType: 'image/png', bytes: Buffer.from([2]) }).run();
    db.insert(syncError).values({ logId: 'log2', path: 'releases/bad2.json', message: 'y', at: '2026-09-15T00:00:00.000Z' }).run();
    db.insert(repoPermission).values({ accountId: 42, logId: 'log2', canWrite: true, checkedAt: '2026-09-15T00:00:00.000Z' }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'Auri CRM' }, cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/dashboard');
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 0);
      assert.equal(db.select().from(release).where(eq(release.logId, 'log1')).all().length, 0);
      assert.equal(db.select().from(media).where(eq(media.logId, 'log1')).all().length, 0);
      assert.equal(db.select().from(syncError).where(eq(syncError.logId, 'log1')).all().length, 0);
      assert.equal(db.select().from(repoPermission).where(eq(repoPermission.logId, 'log1')).all().length, 0);
      // Prove the delete was scoped to log1, not a blanket table wipe
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log2')).all().length, 1);
      assert.equal(db.select().from(release).where(eq(release.logId, 'log2')).all().length, 1);
      assert.equal(db.select().from(media).where(eq(media.logId, 'log2')).all().length, 1);
      assert.equal(db.select().from(syncError).where(eq(syncError.logId, 'log2')).all().length, 1);
      assert.equal(db.select().from(repoPermission).where(eq(repoPermission.logId, 'log2')).all().length, 1);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('POST delete with the wrong name changes nothing', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'the wrong name' }, cookie);
      assert.equal(res.status, 400);
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 1, 'the log must survive a wrong confirmation');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('the wrong-confirmation-name error page escapes the product name', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: '<b>x</b>', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'the wrong name' }, cookie);
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(!html.includes('<b>x</b>'), 'the raw product tag must never appear unescaped on the wrong-name error page');
      assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), 'the product name must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a frozen log can be deleted by an admin even without canWrite', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'gone-repo', repoNodeId: 'R_log1',
      product: 'Gone Product', view: 'full', visibility: 'public', curationNotes: null,
      state: 'frozen', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => null, putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    // 'octocat' is this fixture's admin.
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'Gone Product' }, cookie);
      assert.equal(res.status, 302);
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('delete without write access (and not admin, not frozen) is refused with 403', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'Auri CRM' }, cookie);
      assert.equal(res.status, 403);
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 1);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /admin/allowlist for a non-admin is refused with 403', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 99);
    db.insert(account).values({ githubUserId: 99, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 403);
    }, undefined, auth);
  });
});

test('GET /admin/allowlist for an admin lists the current entries', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: 'trusted contractor' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('someone'));
      assert.ok(html.includes('trusted contractor'));
    }, undefined, auth);
  });
});

test('POST /admin/allowlist adds a login, recording who added it', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/admin/allowlist', { github_login: 'new-person', note: 'joined the team' }, cookie);
      assert.equal(res.status, 302);
      const row = db.select().from(allowlist).where(eq(allowlist.githubLogin, 'new-person')).all()[0];
      assert.equal(row.addedBy, 'octocat');
      assert.equal(row.note, 'joined the team');
    }, undefined, auth);
  });
});

test('POST /admin/allowlist by a non-admin is refused and adds nothing', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 99);
    db.insert(account).values({ githubUserId: 99, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/admin/allowlist', { github_login: 'sneaky', note: '' }, cookie);
      assert.equal(res.status, 403);
      assert.equal(db.select().from(allowlist).where(eq(allowlist.githubLogin, 'sneaky')).all().length, 0);
    }, undefined, auth);
  });
});

test('POST /admin/allowlist/:login/delete removes exactly that entry', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'keep-me', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    db.insert(allowlist).values({ githubLogin: 'remove-me', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist/remove-me/delete`, { method: 'POST', headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(db.select().from(allowlist).where(eq(allowlist.githubLogin, 'remove-me')).all().length, 0);
      assert.equal(db.select().from(allowlist).where(eq(allowlist.githubLogin, 'keep-me')).all().length, 1, 'removing one entry must not touch another');
    }, undefined, auth);
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

test('re-adding an existing allowlist login with a different note updates the row', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'alice', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: 'old note' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/admin/allowlist', { github_login: 'alice', note: 'new note' }, cookie);
      assert.equal(res.status, 302);
      const row = db.select().from(allowlist).where(eq(allowlist.githubLogin, 'alice')).all()[0];
      assert.equal(row.note, 'new note', 'note should be updated on conflict');
      assert.equal(row.addedBy, 'octocat', 'addedBy should be updated to current admin on conflict');
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

test('POST /admin/allowlist/:login/delete with a malformed percent-sequence answers 400', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist/%zz/delete`, { method: 'POST', headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 400);
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

test('a callback with no login_next cookie still redirects to /me (unchanged default)', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const loginRes = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const setCookies = loginRes.headers.getSetCookie?.() ?? [];
      const stateCookie = setCookies.find((c) => c.startsWith('oauth_state='))!.split(';')[0];
      const state = stateCookie.split('=')[1];
      const cbRes = await fetch(`${base}/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual', headers: { cookie: stateCookie },
      });
      assert.equal(cbRes.headers.get('location'), '/me');
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

const AUTHORIZE_CHALLENGE = 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8'; // s. Task 2/6

test('GET /oauth/authorize without a session redirects to login with next set', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location')!;
      assert.ok(location.startsWith('/auth/github/login?next='));
      assert.ok(location.includes(encodeURIComponent('/oauth/authorize?')));
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with a session shows the consent screen naming the client and scope', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Test Client'));
      assert.ok(html.includes('logs:read'));
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with an unknown client_id is refused without redirecting anywhere', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=nonexistent&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 400, 'an unknown client must never produce a redirect -- there is nowhere trusted to send it');
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with a redirect_uri not registered for this client answers 400, not a redirect', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base, 'https://client.example/cb');
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://attacker.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 400);
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with code_challenge_method=plain redirects back with error, never issuing a code', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=abc&code_challenge_method=plain&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'invalid_request');
      assert.equal(location.searchParams.get('state'), 'xyz');
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with an unknown scope redirects back with invalid_scope', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:delete`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'invalid_scope');
    }, undefined, auth);
  });
});

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

const AUTHORIZE_VERIFIER = 'test-verifier-1234567890123456789012345'; // s. Task 2

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

test('POST /oauth/token with a wrong code_verifier is refused', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: 'wrong',
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

test('GET /dashboard/connections lists a connected client and its scope', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      // authorizeAndGetCode only issues a code -- exchange it so a real
      // refresh token exists to be listed.
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      const res = await fetch(`${base}/dashboard/connections`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Test Client'));
    }, undefined, auth);
  });
});

test('POST /dashboard/connections/:clientId/revoke removes the connection', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      const revokeRes = await fetch(`${base}/dashboard/connections/${clientId}/revoke`, {
        method: 'POST', headers: { cookie: `session=${cookie}` }, redirect: 'manual',
      });
      assert.equal(revokeRes.status, 302);
      const listRes = await fetch(`${base}/dashboard/connections`, { headers: { cookie: `session=${cookie}` } });
      const html = await listRes.text();
      assert.ok(!html.includes('Test Client'), 'a revoked client must no longer be listed');
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
