import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt } from './appAuth.ts';
import type { AppConfig } from './config.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG: AppConfig = {
  appId: '12345',
  privateKey,
  webhookSecret: 'shhh',
  baseUrl: 'https://example.test',
};

function parts(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
  };
}

test('the jwt verifies against the public key', () => {
  const token = appJwt(CONFIG);
  const [h, p, signature] = token.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

test('the header declares RS256', () => {
  assert.equal(parts(appJwt(CONFIG)).header.alg, 'RS256');
});

test('the issuer is the app id', () => {
  assert.equal(parts(appJwt(CONFIG)).payload.iss, '12345');
});

test('iat is backdated and exp is under ten minutes out', () => {
  const now = 1_800_000_000;
  const { payload } = parts(appJwt(CONFIG, now));
  // GitHub rejects a token whose iat is in the future by even a second of
  // clock skew, and refuses any exp more than 10 minutes ahead.
  assert.ok((payload.iat as number) < now, 'iat must be backdated against clock skew');
  assert.ok((payload.exp as number) > now, 'exp must be in the future');
  assert.ok((payload.exp as number) - now <= 600, 'exp must be at most 10 minutes ahead');
  // GitHub's ceiling is exp - iat, not exp - now: iat is already backdated
  // by SKEW_SECONDS, so `exp - now <= 600` holds for any LIFETIME_SECONDS
  // at or under 600 regardless of the skew added on top. Pin the sum that
  // actually has to stay under GitHub's 10-minute limit.
  assert.ok((payload.exp as number) - (payload.iat as number) <= 600, 'exp - iat must be at most 10 minutes');
});

test('a tampered payload no longer verifies', () => {
  const token = appJwt(CONFIG);
  const [h, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ iss: '99999' }), 'utf8').toString('base64url');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${forged}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), false);
});

import { installations } from './appAuth.ts';
import { fakeHttp } from './http.ts';

const REF = { owner: 'o', repo: 'r' };

function inAnHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

test('tokenFor exchanges the app jwt for an installation token', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const token = await installations(CONFIG, http).tokenFor(REF);
  assert.equal(token, 'ghs_abc');
});

test('a repository with no installation yields null, not a throw', async () => {
  const http = fakeHttp({ 'GET /repos/o/r/installation': { status: 404 } });
  assert.equal(await installations(CONFIG, http).tokenFor(REF), null);
});

test('a second call for the same installation does not mint a second token', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http);
  await inst.tokenFor(REF);
  await inst.tokenFor(REF);
  const mints = http.calls.filter((c) => c.startsWith('POST /app/installations'));
  assert.equal(mints.length, 1, 'the cached token must be reused');
});

test('a token close to expiry is replaced before it expires', async () => {
  let clock = 1_000_000;
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': [
      { body: { token: 'first', expires_at: new Date(clock + 120_000).toISOString() } },
      { body: { token: 'second', expires_at: new Date(clock + 3_600_000).toISOString() } },
    ],
  });
  const inst = installations(CONFIG, http, () => clock);
  assert.equal(await inst.tokenFor(REF), 'first');
  // Still 90 seconds of nominal life left, but inside the safety margin.
  clock += 30_000;
  assert.equal(await inst.tokenFor(REF), 'second');
});

test('two repositories in one installation share its token', async () => {
  const http = fakeHttp({
    'GET /repos/o/one/installation': { body: { id: 7 } },
    'GET /repos/o/two/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http);
  await inst.tokenFor({ owner: 'o', repo: 'one' });
  await inst.tokenFor({ owner: 'o', repo: 'two' });
  const mints = http.calls.filter((c) => c.startsWith('POST /app/installations'));
  assert.equal(mints.length, 1, 'the cache is keyed by installation, not by repository');
});

test('the installation id is resolved once, not on every call', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http, () => Date.now());
  await inst.tokenFor(REF);
  await inst.tokenFor(REF);
  await inst.tokenFor(REF);
  const lookups = http.calls.filter((c) => c === 'GET /repos/o/r/installation');
  assert.equal(lookups.length, 1, 'die Installations-ID ändert sich nicht zwischen zwei Aufrufen');
});

test('invalidate drops both the token and the resolved installation id', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': [
      { body: { token: 'first', expires_at: inAnHour() } },
      { body: { token: 'second', expires_at: inAnHour() } },
    ],
  });
  const inst = installations(CONFIG, http, () => Date.now());
  assert.equal(await inst.tokenFor(REF), 'first');
  inst.invalidate(REF);
  assert.equal(await inst.tokenFor(REF), 'second', 'nach invalidate wird neu geprägt');
  const lookups = http.calls.filter((c) => c === 'GET /repos/o/r/installation');
  assert.equal(lookups.length, 2, 'auch die ID wird neu aufgelöst — ein Transfer ändert sie');
});

test('invalidating another repository does not clear the whole cache', async () => {
  // The prior test called invalidate on an unknown repo and asserted only the
  // absence of a throw — but Map.delete(undefined) never throws, so the test
  // passed when the guard was deleted. What matters is containment: invalidating
  // one repository must not clear the cache of another. The mint count shows
  // this: if cache.clear() is called, the next tokenFor() remints (count=2);
  // if only one entry is deleted, it reuses from cache (count=1).
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http);

  // Mint and cache a token for the first repository.
  await inst.tokenFor(REF);
  let mints = http.calls.filter((c) => c.startsWith('POST /app/installations'));
  assert.equal(mints.length, 1, 'first token is minted and cached');

  // Invalidate a different repository that was never looked up. This must not
  // throw, and must not disturb the cache.
  inst.invalidate({ owner: 'other', repo: 'repo' });

  // The first repository must still draw from cache, not remint.
  await inst.tokenFor(REF);
  mints = http.calls.filter((c) => c.startsWith('POST /app/installations'));
  assert.equal(mints.length, 1, 'cache is not cleared by invalidating another repository');
});
