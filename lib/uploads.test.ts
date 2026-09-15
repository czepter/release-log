import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { uploadToken } from './db/schema.ts';
import { eq } from 'drizzle-orm';
import { sha256Hex } from './oauth.ts';
import { mintUploadToken, redeemUploadToken, normalizeMediaPath, UPLOAD_TOKEN_TTL_MS } from './uploads.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-uploads-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const INPUT = { logId: 'log1', path: 'media/x.png', accountId: 42, contentType: 'image/png' };

test('a minted upload token redeems once, carrying its whole binding', () => {
  withDb((db) => {
    const { token, expiresAt } = mintUploadToken(db, INPUT, () => '2026-09-15T12:00:00.000Z');
    assert.equal(expiresAt, new Date(Date.parse('2026-09-15T12:00:00.000Z') + UPLOAD_TOKEN_TTL_MS).toISOString());
    const result = redeemUploadToken(db, token, () => Date.parse('2026-09-15T12:05:00.000Z'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, { logId: 'log1', path: 'media/x.png', accountId: 42, contentType: 'image/png' });
  });
});

test('the token itself is never stored, only its hash', () => {
  // Dieselbe Regel wie für jedes andere Token dieses Systems (spec §5):
  // was in der Datenbank steht, reicht zum Prüfen und nicht zum Benutzen.
  withDb((db) => {
    const { token } = mintUploadToken(db, INPUT);
    const rows = db.select().from(uploadToken).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenHash, sha256Hex(token));
    assert.notEqual(rows[0].tokenHash, token);
  });
});

test('a second redemption of the same token fails', () => {
  withDb((db) => {
    const { token } = mintUploadToken(db, INPUT);
    assert.equal(redeemUploadToken(db, token).ok, true);
    const second = redeemUploadToken(db, token);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error, 'invalid_token');
  });
});

test('a token past its ten minutes is refused, and stays refused', () => {
  withDb((db) => {
    const { token } = mintUploadToken(db, INPUT, () => '2026-09-15T12:00:00.000Z');
    const justPast = Date.parse('2026-09-15T12:00:00.000Z') + UPLOAD_TOKEN_TTL_MS;
    assert.equal(redeemUploadToken(db, token, () => justPast).ok, false, 'the expiry second itself is already too late');
    assert.equal(redeemUploadToken(db, token, () => justPast - 1).ok, true, 'one millisecond earlier still works');
  });
});

test('an unknown token is refused without touching anything', () => {
  withDb((db) => {
    const result = redeemUploadToken(db, 'not-a-token-anyone-ever-minted');
    assert.equal(result.ok, false);
    assert.equal(db.select().from(uploadToken).all().length, 0);
  });
});

test('redeeming marks the row consumed rather than deleting it', () => {
  // Der Unterschied zählt: eine gelöschte Zeile wäre von einem nie
  // ausgestellten Token nicht zu unterscheiden, und genau dieser
  // Unterschied ist das, was "einmalig" beweisbar macht.
  withDb((db) => {
    const { token } = mintUploadToken(db, INPUT);
    redeemUploadToken(db, token, () => Date.parse('2026-09-15T12:01:00.000Z'));
    const row = db.select().from(uploadToken).where(eq(uploadToken.tokenHash, sha256Hex(token))).all()[0];
    assert.ok(row, 'the row must survive its redemption');
    assert.equal(row.consumedAt, '2026-09-15T12:01:00.000Z');
  });
});

test('a bare filename and an explicit media/ prefix name the same target', () => {
  assert.equal(normalizeMediaPath('screenshot.png'), 'media/screenshot.png');
  assert.equal(normalizeMediaPath('media/screenshot.png'), 'media/screenshot.png');
});

test('anything with further path structure is not a media path', () => {
  // Kein Pfad-Guard dahinter, der das noch auffangen würde: was hier
  // durchkäme, ginge genau so in einen Commit.
  for (const bad of ['../secrets', 'media/../secrets', 'a/b.png', 'media/a/b.png', 'C:\\x.png', '', '.', '..', 'media/']) {
    assert.equal(normalizeMediaPath(bad), null, `"${bad}" must not be a media path`);
  }
});
