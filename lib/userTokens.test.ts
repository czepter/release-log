import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from './db/client.ts';
import { githubUserToken } from './db/schema.ts';
import { fakeHttp } from './http.ts';
import type { Http } from './http.ts';
import { cipher } from './secrets.ts';
import { userTokens } from './userTokens.ts';
import type { UserTokens } from './userTokens.ts';

const KEY = Buffer.alloc(32, 4);
const NOW = Date.parse('2026-09-15T12:00:00.000Z');

function withTokens(
  fn: (users: UserTokens, db: ReturnType<typeof openDb>, http: Http & { calls: string[] }) => Promise<void> | void,
  routes: Parameters<typeof fakeHttp>[0] = {},
  nowMs: () => number = () => NOW,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-usertokens-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const http = fakeHttp(routes);
  const users = userTokens({
    db, http, cipher: cipher(KEY), clientId: 'Iv1.test', clientSecret: 'test-client-secret', nowMs,
  });
  return Promise.resolve(fn(users, db, http)).finally(() => { rmSync(dir, { recursive: true, force: true }); }) as Promise<void>;
}

const FRESH = {
  accessToken: 'gho_fresh',
  accessExpiresAt: new Date(NOW + 8 * 60 * 60 * 1000).toISOString(),
  refreshToken: 'ghr_stored',
  refreshExpiresAt: new Date(NOW + 181 * 24 * 60 * 60 * 1000).toISOString(),
};

const STALE = {
  ...FRESH,
  accessToken: 'gho_stale',
  accessExpiresAt: new Date(NOW - 1000).toISOString(),
};

test('a stored, still-valid access token comes back without asking GitHub', async () => {
  await withTokens(async (users, _db, http) => {
    users.store(42, FRESH);
    assert.deepEqual(await users.tokenFor(42), { ok: true, token: 'gho_fresh' });
    assert.deepEqual(http.calls, [], 'a valid token costs no round-trip');
  });
});

test('an account with no stored token must sign in again', async () => {
  await withTokens(async (users) => {
    assert.deepEqual(await users.tokenFor(42), { ok: false, error: 'reauth_required' });
  });
});

test('neither token is stored in the clear', async () => {
  await withTokens(async (users, db) => {
    users.store(42, FRESH);
    const row = db.select().from(githubUserToken).where(eq(githubUserToken.accountId, 42)).all()[0];
    assert.ok(!row.accessTokenEnc.includes('gho_fresh'), 'the access token must not be readable in the row');
    assert.ok(!(row.refreshTokenEnc ?? '').includes('ghr_stored'), 'the refresh token must not be readable in the row');
    // Die Ablaufzeiten sind keine Geheimnisse und bleiben lesbar -- ohne
    // sie müsste jede Prüfung erst entschlüsseln.
    assert.equal(row.accessExpiresAt, FRESH.accessExpiresAt);
  });
});

test('a token minutes from expiry is refreshed rather than used', async () => {
  // Ein Token, das mitten in der Anfrage stirbt, die es trägt, ist ein
  // Fehler, den der Aufrufer nicht von einem Entzug unterscheiden kann.
  await withTokens(async (users, _db, http) => {
    users.store(42, { ...FRESH, accessExpiresAt: new Date(NOW + 30_000).toISOString() });
    const result = await users.tokenFor(42);
    assert.deepEqual(result, { ok: true, token: 'gho_refreshed' });
    assert.deepEqual(http.calls, ['POST /login/oauth/access_token']);
  }, {
    'POST /login/oauth/access_token': {
      body: { access_token: 'gho_refreshed', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 15811200 },
    },
  });
});

test('a refresh replaces both tokens in one row, in one write', async () => {
  // Ein halb geschriebener Datensatz sperrt das Konto aus: GitHub widerruft
  // das alte Access-Token, sobald der Refresh durch ist.
  await withTokens(async (users, db) => {
    users.store(42, STALE);
    assert.deepEqual(await users.tokenFor(42), { ok: true, token: 'gho_refreshed' });
    const row = db.select().from(githubUserToken).where(eq(githubUserToken.accountId, 42)).all()[0];
    assert.equal(cipher(KEY).decrypt(row.accessTokenEnc), 'gho_refreshed');
    assert.equal(cipher(KEY).decrypt(row.refreshTokenEnc as string), 'ghr_new');
    assert.equal(row.accessExpiresAt, new Date(NOW + 28800 * 1000).toISOString());
    assert.equal(row.refreshExpiresAt, new Date(NOW + 15811200 * 1000).toISOString());
    // Und die zweite Abfrage nimmt das neue Token, ohne noch einmal zu fragen.
    assert.deepEqual(await users.tokenFor(42), { ok: true, token: 'gho_refreshed' });
  }, {
    'POST /login/oauth/access_token': {
      body: { access_token: 'gho_refreshed', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 15811200 },
    },
  });
});

test('two callers arriving at once share one refresh', async () => {
  // Zwei gleichzeitige Refreshes widerrufen einander: der zweite entwertet
  // das Token, das der erste gerade bekommen hat. Genau das passiert nach
  // einer Pause, wenn mehrere Aufrufe zugleich eintreffen.
  await withTokens(async (users, _db, http) => {
    users.store(42, STALE);
    const [first, second] = await Promise.all([users.tokenFor(42), users.tokenFor(42)]);
    assert.deepEqual(first, { ok: true, token: 'gho_refreshed' });
    assert.deepEqual(second, { ok: true, token: 'gho_refreshed' }, 'the second caller must get the first refresh, not a second one');
    assert.deepEqual(http.calls, ['POST /login/oauth/access_token'], 'exactly one refresh may reach GitHub');
  }, {
    // Die zweite Antwort ist mit Absicht ein Fehlschlag: liefe ein zweiter
    // Refresh, sähe man es sofort am Ergebnis.
    'POST /login/oauth/access_token': [
      { body: { access_token: 'gho_refreshed', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 15811200 } },
      { body: { error: 'bad_refresh_token' } },
    ],
  });
});

test('a refresh GitHub refuses ends in reauth_required and throws the dead grant away', async () => {
  // GitHub beantwortet ein totes Refresh-Token mit HTTP 200 und einem
  // error-Feld, nicht mit einem Fehlerstatus.
  await withTokens(async (users, db) => {
    users.store(42, STALE);
    assert.deepEqual(await users.tokenFor(42), { ok: false, error: 'reauth_required' });
    assert.equal(db.select().from(githubUserToken).all().length, 0, 'an unusable grant must not cost a round-trip on every later call');
  }, { 'POST /login/oauth/access_token': { body: { error: 'bad_refresh_token' } } });
});

test('a refresh that fails on the wire keeps the stored grant', async () => {
  // Ein Serverfehler ist keine Aussage über das Token. Es wegzuwerfen
  // hieße, ein Konto wegen einer GitHub-Störung auszusperren.
  await withTokens(async (users, db) => {
    users.store(42, STALE);
    assert.deepEqual(await users.tokenFor(42), { ok: false, error: 'github_unavailable' });
    assert.equal(db.select().from(githubUserToken).all().length, 1, 'the grant stays -- it was never refused');
  }, { 'POST /login/oauth/access_token': { status: 503 } });
});

test('an expired refresh token is not even tried', async () => {
  await withTokens(async (users, _db, http) => {
    users.store(42, {
      ...STALE,
      refreshExpiresAt: new Date(NOW - 1000).toISOString(),
    });
    assert.deepEqual(await users.tokenFor(42), { ok: false, error: 'reauth_required' });
    assert.deepEqual(http.calls, [], 'a dead refresh token is not worth a round-trip');
  });
});

test('a token without an expiry is used forever, with no refresh token needed', async () => {
  // Der Fall „Expire user authorization tokens" abgeschaltet: GitHub gibt
  // weder expires_in noch ein Refresh-Token.
  await withTokens(async (users, _db, http) => {
    users.store(42, { accessToken: 'gho_forever', accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
    assert.deepEqual(await users.tokenFor(42), { ok: true, token: 'gho_forever' });
    assert.deepEqual(http.calls, []);
  });
});

test('a row this key cannot decrypt sends the account back to signing in', async () => {
  // Schlüssel gewechselt oder Zeile verändert: kein Absturz, sondern eine
  // Anmeldung.
  await withTokens(async (users, db) => {
    users.store(42, FRESH);
    db.update(githubUserToken).set({ accessTokenEnc: 'v1.aaaa.bbbb.cccc', refreshTokenEnc: null })
      .where(eq(githubUserToken.accountId, 42)).run();
    assert.deepEqual(await users.tokenFor(42), { ok: false, error: 'reauth_required' });
  });
});

test('forget removes the grant, store puts a fresh one back', async () => {
  await withTokens(async (users, db) => {
    users.store(42, FRESH);
    users.forget(42);
    assert.equal(db.select().from(githubUserToken).all().length, 0);
    users.store(42, FRESH);
    assert.deepEqual(await users.tokenFor(42), { ok: true, token: 'gho_fresh' });
  });
});

test('a second login for the same account replaces the first grant, not adds to it', async () => {
  await withTokens(async (users, db) => {
    users.store(42, FRESH);
    users.store(42, { ...FRESH, accessToken: 'gho_second_login' });
    assert.equal(db.select().from(githubUserToken).all().length, 1);
    assert.deepEqual(await users.tokenFor(42), { ok: true, token: 'gho_second_login' });
  });
});
