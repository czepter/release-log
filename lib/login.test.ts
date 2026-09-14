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
