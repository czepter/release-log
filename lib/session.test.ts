import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { allowlist } from './db/schema.ts';
import { createSessionCookie, verifySessionCookie, isAdmin, isAllowed } from './session.ts';

const KEY = 'test-signing-key-do-not-use-in-production';
const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-session-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a cookie verifies back to the account id it was created for', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  assert.deepEqual(verifySessionCookie(KEY, cookie, NOW), { accountId: 42 });
});

test('a cookie signed with a different key does not verify', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  assert.equal(verifySessionCookie('a-different-signing-key', cookie, NOW), null);
});

test('a tampered payload does not verify, even with the right signature format', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  const [payload, signature] = cookie.split('.');
  const forged = Buffer.from(JSON.stringify({ accountId: 99, exp: NOW + 30 * DAY }), 'utf8').toString('base64url');
  assert.equal(verifySessionCookie(KEY, `${forged}.${signature}`, NOW), null);
  void payload;
});

test('a cookie is valid at 29 days and expired at 31 days', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  assert.notEqual(verifySessionCookie(KEY, cookie, NOW + 29 * DAY), null);
  assert.equal(verifySessionCookie(KEY, cookie, NOW + 31 * DAY), null);
});

test('a missing, empty or malformed cookie does not verify', () => {
  assert.equal(verifySessionCookie(KEY, undefined, NOW), null);
  assert.equal(verifySessionCookie(KEY, '', NOW), null);
  assert.equal(verifySessionCookie(KEY, 'not-a-cookie-at-all', NOW), null);
  assert.equal(verifySessionCookie(KEY, 'onlyonepart', NOW), null);
  assert.equal(verifySessionCookie(KEY, '....', NOW), null);
});

test('isAdmin checks ADMIN_LOGINS only, nothing else', () => {
  assert.equal(isAdmin('czepter', ['czepter', 'other']), true);
  assert.equal(isAdmin('nobody', ['czepter', 'other']), false);
});

test('isAllowed says yes for an admin login even with an empty allowlist table', () => {
  withDb((db) => {
    assert.equal(isAllowed(db, 'czepter', ['czepter']), true);
  });
});

test('isAllowed says yes for a login the allowlist table names', () => {
  withDb((db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'czepter', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    assert.equal(isAllowed(db, 'someone', ['czepter']), true);
  });
});

test('isAllowed says no for a login in neither place', () => {
  withDb((db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'czepter', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    assert.equal(isAllowed(db, 'a-stranger', ['czepter']), false);
  });
});
