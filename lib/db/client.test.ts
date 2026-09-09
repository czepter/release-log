import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from './client.ts';
import { log } from './schema.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-db-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('openDb creates the schema and round-trips a log row', () => {
  withDb((db) => {
    db.insert(log).values({
      publicId: 'abc123',
      repoOwner: 'czepter',
      repoName: 'release-log',
      product: 'Demo',
      view: 'full',
      visibility: 'public',
      curationNotes: null,
      state: 'active',
      headSha: null,
      configBlobSha: null,
      indexedAt: null,
    }).run();

    const rows = db.select().from(log).where(eq(log.publicId, 'abc123')).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product, 'Demo');
    assert.equal(rows[0].state, 'active');
  });
});

test('openDb is idempotent — reopening an existing file keeps the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-db-'));
  const path = join(dir, 'test.sqlite');
  try {
    openDb(path).insert(log).values({
      publicId: 'keep', repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();

    const rows = openDb(path).select().from(log).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].publicId, 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate publicId is rejected by the primary key', () => {
  withDb((db) => {
    const row = {
      publicId: 'dup', repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    };
    db.insert(log).values(row).run();
    assert.throws(() => db.insert(log).values(row).run());
  });
});
