import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHttp } from './http.ts';
import { exchangeCodeForIdentity } from './login.ts';

test('a successful exchange returns the identity from GET /user', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_abc', token_type: 'bearer' } },
    'GET /user': { body: { id: 42, login: 'octocat', avatar_url: 'https://example.test/a.png' } },
  });
  const identity = await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'the-code', 'https://example.test/auth/github/callback');
  assert.deepEqual(identity, { id: 42, login: 'octocat', avatarUrl: 'https://example.test/a.png' });
});

test('the user token reaches GET /user as a bearer header and nowhere else', async () => {
  const seen: string[] = [];
  const inner = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_secret_value' } },
    'GET /user': { body: { id: 1, login: 'a', avatar_url: null } },
  });
  const http = Object.assign(
    (url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''));
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'the-code', 'https://example.test/cb');
  assert.deepEqual(seen, ['', 'Bearer gho_secret_value']);
});

test('the token exchange POSTs to github.com with the full body GitHub expects', async () => {
  // fakeHttp's routing key is METHOD + pathname + search only (see
  // lib/http.ts's keyOf) -- it discards the host entirely, so no test
  // built only on fakeHttp's routes can tell github.com apart from
  // evil.example, and none of the existing tests inspect the request body
  // at all. Capture both directly, on the raw url/init this module hands
  // to http(), before fakeHttp ever sees them.
  const calls: { url: string; body: string }[] = [];
  const inner = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_abc' } },
    'GET /user': { body: { id: 42, login: 'octocat', avatar_url: null } },
  });
  const http = Object.assign(
    (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'the-code', 'https://example.test/auth/github/callback');

  assert.ok(calls[0].url.startsWith('https://github.com/'), `expected a github.com URL, got ${calls[0].url}`);
  assert.deepEqual(JSON.parse(calls[0].body), {
    client_id: 'client-id',
    client_secret: 'client-secret',
    code: 'the-code',
    redirect_uri: 'https://example.test/auth/github/callback',
  });
});

test('a missing avatar_url becomes null, not undefined or a throw', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 't' } },
    'GET /user': { body: { id: 1, login: 'a' } },
  });
  const identity = await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'code', 'https://example.test/cb');
  assert.equal(identity?.avatarUrl, null);
});

test('a token exchange that fails yields null, not a throw', async () => {
  const http = fakeHttp({ 'POST /login/oauth/access_token': { status: 401 } });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'bad-code', 'https://example.test/cb'), null);
});

test('a response with no access_token yields null', async () => {
  const http = fakeHttp({ 'POST /login/oauth/access_token': { body: { error: 'bad_verification_code' } } });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'bad-code', 'https://example.test/cb'), null);
  // The missing token is a dead end: nothing after the exchange may run, so
  // GET /user must never appear in the call log.
  assert.deepEqual(http.calls, ['POST /login/oauth/access_token']);
});

test('a GET /user that fails yields null, not a throw', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 't' } },
    'GET /user': { status: 401 },
  });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'code', 'https://example.test/cb'), null);
});

test('a user response missing id or login yields null', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 't' } },
    'GET /user': { body: { login: 'a' } },
  });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'code', 'https://example.test/cb'), null);
});
