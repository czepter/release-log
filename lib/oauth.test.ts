import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { oauthClient, oauthToken } from './db/schema.ts';
import { eq } from 'drizzle-orm';
import { registerClient, mintAuthorizationCode, redeemAuthorizationCode, revokeFamily } from './oauth.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-oauth-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registers a client with a valid https redirect_uri', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['https://client.example/cb'], client_name: 'Test Client' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clientName, 'Test Client');
    assert.deepEqual(result.value.redirectUris, ['https://client.example/cb']);
    const row = db.select().from(oauthClient).where(eq(oauthClient.clientId, result.value.clientId)).all()[0];
    assert.ok(row, 'the client must actually be persisted');
    assert.deepEqual(JSON.parse(row.redirectUris), ['https://client.example/cb']);
  });
});

test('a loopback http redirect_uri is accepted (RFC 8252 native clients)', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['http://127.0.0.1:51234/cb'] });
    assert.equal(result.ok, true);
  });
});

test('a plain http redirect_uri on a non-loopback host is rejected', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['http://client.example/cb'] });
    assert.equal(result.ok, false);
  });
});

test('an empty redirect_uris list is rejected, and nothing is persisted', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: [] });
    assert.equal(result.ok, false);
    assert.equal(db.select().from(oauthClient).all().length, 0);
  });
});

test('a missing client_name defaults to a placeholder, never crashes', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clientName, 'Unnamed MCP client');
  });
});

test('two registrations produce two distinct client ids', () => {
  withDb((db) => {
    const a = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    const b = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.value.clientId, b.value.clientId);
  });
});

test('a freshly minted code redeems once, with the right client/redirect/verifier', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.accountId, 42);
    assert.equal(result.value.scope, 'logs:read');
    assert.ok(result.value.familyId.length > 0);
  });
});

test('a wrong code_verifier is rejected', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'wrong-verifier',
    });
    assert.equal(result.ok, false);
  });
});

test('a mismatched redirect_uri is rejected, even with the right code and verifier', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://attacker.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(result.ok, false);
  });
});

test('an expired code is rejected', () => {
  withDb((db) => {
    let now = 0;
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    }, () => new Date(now).toISOString());
    now = 61_000; // one second past the 60-second lifetime
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    }, () => now);
    assert.equal(result.ok, false);
  });
});

test('redeeming a code twice fails the second time and revokes every token that code produced', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const first = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    // Stand-in for the token a real /oauth/token exchange would have minted
    // from this same family (Task 8/9) -- this test proves the revocation
    // side effect works before token issuance exists to prove it end-to-end.
    db.insert(oauthToken).values({
      id: 'tok1', familyId: first.value.familyId, clientId: 'c1', accountId: 42, scope: 'logs:read',
      kind: 'access', tokenHash: 'irrelevant-hash', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }).run();

    const second = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(second.ok, false, 'a second redemption of the same code must fail');

    const tokenRow = db.select().from(oauthToken).where(eq(oauthToken.id, 'tok1')).all()[0];
    assert.notEqual(tokenRow.revokedAt, null, 'the token minted from this code must be revoked');
  });
});
