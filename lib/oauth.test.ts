import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { oauthClient, oauthToken } from './db/schema.ts';
import { eq } from 'drizzle-orm';
import { registerClient, mintAuthorizationCode, redeemAuthorizationCode, revokeFamily, mintTokenPair, lookupAccessToken } from './oauth.ts';
import { account } from './db/schema.ts';

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

test('a replay of an already-consumed code still revokes the family, even with the wrong code_verifier', () => {
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
    db.insert(oauthToken).values({
      id: 'tok-wrong-verifier', familyId: first.value.familyId, clientId: 'c1', accountId: 42, scope: 'logs:read',
      kind: 'access', tokenHash: 'irrelevant-hash-1', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }).run();

    // Replay with a WRONG code_verifier -- revocation must still fire,
    // because consumedAt !== null is checked before PKCE.
    const second = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'a-completely-wrong-verifier',
    });
    assert.equal(second.ok, false, 'a second redemption must fail even with the wrong verifier');

    const tokenRow = db.select().from(oauthToken).where(eq(oauthToken.id, 'tok-wrong-verifier')).all()[0];
    assert.notEqual(tokenRow.revokedAt, null, 'the family must be revoked regardless of what the replay supplies');
  });
});

test('revoking one family on replay does not touch a different family\'s token', () => {
  withDb((db) => {
    const codeA = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const codeB = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const firstA = redeemAuthorizationCode(db, {
      code: codeA, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    const firstB = redeemAuthorizationCode(db, {
      code: codeB, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(firstA.ok, true);
    assert.equal(firstB.ok, true);
    if (!firstA.ok || !firstB.ok) return;
    assert.notEqual(firstA.value.familyId, firstB.value.familyId, 'two mints must produce two distinct families');

    db.insert(oauthToken).values({
      id: 'tok-family-a', familyId: firstA.value.familyId, clientId: 'c1', accountId: 42, scope: 'logs:read',
      kind: 'access', tokenHash: 'irrelevant-hash-a', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }).run();
    db.insert(oauthToken).values({
      id: 'tok-family-b', familyId: firstB.value.familyId, clientId: 'c1', accountId: 42, scope: 'logs:read',
      kind: 'access', tokenHash: 'irrelevant-hash-b', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }).run();

    // Replay only code A a second time.
    const secondA = redeemAuthorizationCode(db, {
      code: codeA, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(secondA.ok, false);

    const tokenA = db.select().from(oauthToken).where(eq(oauthToken.id, 'tok-family-a')).all()[0];
    const tokenB = db.select().from(oauthToken).where(eq(oauthToken.id, 'tok-family-b')).all()[0];
    assert.notEqual(tokenA.revokedAt, null, 'family A\'s token must be revoked');
    assert.equal(tokenB.revokedAt, null, 'family B\'s token must be untouched');
  });
});

test('a wrong client_id is rejected, even with the right redirect_uri, code and verifier', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'attacker-client', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(result.ok, false);
  });
});

test('a minted access token looks up to the right account, client and scope', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read logs:write', familyId: 'fam1' });
    const looked = lookupAccessToken(db, pair.accessToken);
    assert.ok(looked);
    assert.equal(looked!.accountId, 42);
    assert.equal(looked!.login, 'octocat');
    assert.equal(looked!.clientId, 'c1');
    assert.equal(looked!.scope, 'logs:read logs:write');
  });
});

test('the refresh token does not look up as an access token', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    assert.equal(lookupAccessToken(db, pair.refreshToken), null);
  });
});

test('an expired access token is rejected', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    let now = 0;
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' }, () => new Date(now).toISOString());
    now = 60 * 60 * 1000 + 1; // one millisecond past the one-hour lifetime
    assert.equal(lookupAccessToken(db, pair.accessToken, () => now), null);
  });
});

test('an unknown token is rejected', () => {
  withDb((db) => {
    assert.equal(lookupAccessToken(db, 'never-issued'), null);
  });
});

test('lookupAccessToken returns expiresAt in seconds, not milliseconds', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const before = Date.now();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const looked = lookupAccessToken(db, pair.accessToken);
    assert.ok(looked);
    const expiresAtMs = looked!.expiresAt * 1000;
    assert.ok(Math.abs(expiresAtMs - (before + 3_600_000)) < 5000, `expiresAt should be ~1 hour out in seconds, got ${looked!.expiresAt}`);
  });
});
