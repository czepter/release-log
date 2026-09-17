import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCtx, signIn } from './fixtures.ts';
import { registerClient } from './oauth.ts';
import { checkAuthorizeRequest } from './oauthRequest.ts';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function query(clientId: string, over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId, redirect_uri: 'http://127.0.0.1:5555/cb', response_type: 'code',
    code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'logs:read', state: 's1', ...over,
  });
}

function client(ctx: Parameters<Parameters<typeof withCtx>[0]>[0]): string {
  const r = registerClient(ctx.auth.db, { client_name: 'Claude', redirect_uris: ['http://127.0.0.1/cb'] });
  if (!r.ok) throw new Error('register failed');
  return r.value.clientId;
}

test('an unknown client is an error, never a redirect', async () => {
  await withCtx(async (ctx) => {
    assert.deepEqual(checkAuthorizeRequest(ctx.auth, 'GET', query('mcp_nope'), '', null), { kind: 'error', reason: 'unknown_client' });
  });
});

// Fällt, wenn isValidCodeChallenge aus der Prüfung verschwindet.
test('a malformed code challenge goes back to the client as invalid_request', async () => {
  await withCtx(async (ctx) => {
    const id = client(ctx);
    const check = checkAuthorizeRequest(ctx.auth, 'GET', query(id, { code_challenge: 'short' }), '', null);
    assert.equal(check.kind, 'redirect');
    if (check.kind !== 'redirect') return;
    const location = new URL(check.location);
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    assert.equal(location.searchParams.get('state'), 's1');
  });
});

test('signed out: login with the original query as next', async () => {
  await withCtx(async (ctx) => {
    const id = client(ctx);
    const q = query(id);
    const check = checkAuthorizeRequest(ctx.auth, 'GET', q, q.toString(), null);
    assert.deepEqual(check, { kind: 'login', location: `/auth/github/login?next=${encodeURIComponent(`/oauth/authorize?${q}`)}` });
  });
});

test('signed in with a valid request: ok, carrying what the form round-trips', async () => {
  await withCtx(async (ctx) => {
    const id = client(ctx);
    const { who } = signIn(ctx, 'dev');
    const check = checkAuthorizeRequest(ctx.auth, 'GET', query(id, { scope: 'logs:read logs:write' }), '', who);
    assert.equal(check.kind, 'ok');
    if (check.kind !== 'ok') return;
    assert.equal(check.client.clientName, 'Claude');
    assert.equal(check.scope, 'logs:read logs:write');
    assert.equal(check.redirectUri, 'http://127.0.0.1:5555/cb');
  });
});

// Aus server.test.ts übernommen, seit die Zustimmungsseite in Nuxt liegt.
test('a loopback redirect_uri may differ from the registered one only in its port (RFC 8252)', async () => {
  await withCtx(async (ctx) => {
    const r = registerClient(ctx.auth.db, { client_name: 'Native', redirect_uris: ['http://[::1]:51234/cb'] });
    if (!r.ok) throw new Error('register failed');
    const { who } = signIn(ctx, 'dev');
    assert.equal(checkAuthorizeRequest(ctx.auth, 'GET', query(r.value.clientId, { redirect_uri: 'http://[::1]:9999/cb' }), '', who).kind, 'ok');
    assert.deepEqual(checkAuthorizeRequest(ctx.auth, 'GET', query(r.value.clientId, { redirect_uri: 'http://[::1]:9999/other' }), '', who), { kind: 'error', reason: 'bad_redirect_uri' });
  });
});

test('code_challenge_method=plain and an unknown scope go back to the client, never to a code', async () => {
  await withCtx(async (ctx) => {
    const id = client(ctx);
    const { who } = signIn(ctx, 'dev');
    const plain = checkAuthorizeRequest(ctx.auth, 'GET', query(id, { code_challenge_method: 'plain' }), '', who);
    assert.equal(plain.kind === 'redirect' && new URL(plain.location).searchParams.get('error'), 'invalid_request');
    const scope = checkAuthorizeRequest(ctx.auth, 'GET', query(id, { scope: 'logs:read admin' }), '', who);
    assert.equal(scope.kind === 'redirect' && new URL(scope.location).searchParams.get('error'), 'invalid_scope');
  });
});

test('a redirect_uri that is not registered is an error, not a redirect', async () => {
  await withCtx(async (ctx) => {
    const id = client(ctx);
    assert.deepEqual(checkAuthorizeRequest(ctx.auth, 'GET', query(id, { redirect_uri: 'https://evil.example/cb' }), '', null), { kind: 'error', reason: 'bad_redirect_uri' });
  });
});
