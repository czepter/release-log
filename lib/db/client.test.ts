import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from './client.ts';
import { log, account, allowlist, repoPermission } from './schema.ts';

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

test('a second log row for the same repository is rejected by the unique index', () => {
  withDb((db) => {
    const base = {
      repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    };
    db.insert(log).values({ ...base, publicId: 'first' }).run();
    assert.throws(() => db.insert(log).values({ ...base, publicId: 'second' }).run());
  });
});

test('an account round-trips by its github user id', () => {
  withDb((db) => {
    db.insert(account).values({
      githubUserId: 42, login: 'octocat', avatarUrl: 'https://example.test/a.png', lastSeenAt: '2026-09-14T00:00:00.000Z',
    }).run();
    const rows = db.select().from(account).where(eq(account.githubUserId, 42)).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].login, 'octocat');
  });
});

test('a second account row for the same github user id is rejected', () => {
  withDb((db) => {
    const row = { githubUserId: 1, login: 'a', avatarUrl: null, lastSeenAt: '2026-09-14T00:00:00.000Z' };
    db.insert(account).values(row).run();
    assert.throws(() => db.insert(account).values(row).run());
  });
});

test('an allowlist row round-trips by its github login', () => {
  withDb((db) => {
    db.insert(allowlist).values({
      githubLogin: 'octocat', addedBy: 'admin-login', addedAt: '2026-09-14T00:00:00.000Z', note: null,
    }).run();
    const rows = db.select().from(allowlist).where(eq(allowlist.githubLogin, 'octocat')).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].addedBy, 'admin-login');
  });
});

test('a repo_permission row is keyed by account and log together', () => {
  withDb((db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();
    db.insert(repoPermission).values({
      accountId: 42, logId: 'log1', canWrite: true, checkedAt: '2026-09-14T00:00:00.000Z',
    }).run();
    const rows = db.select().from(repoPermission).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canWrite, true);
  });
});

test('a second repo_permission row for the same account and log is rejected', () => {
  withDb((db) => {
    db.insert(log).values({
      publicId: 'log2', repoOwner: 'o2', repoName: 'r2', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();
    const row = { accountId: 7, logId: 'log2', canWrite: false, checkedAt: '2026-09-14T00:00:00.000Z' };
    db.insert(repoPermission).values(row).run();
    assert.throws(() => db.insert(repoPermission).values(row).run());
  });
});

test('the same account can hold different cached permissions on different logs', () => {
  withDb((db) => {
    // Insert two different logs with different repos to satisfy the unique index
    db.insert(log).values({
      publicId: 'log-perm-a', repoOwner: 'o', repoName: 'r-a', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();
    db.insert(log).values({
      publicId: 'log-perm-b', repoOwner: 'o', repoName: 'r-b', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();

    // Same account, different logs — both inserts must succeed. A primary key
    // narrowed to accountId alone would wrongly reject the second insert.
    db.insert(repoPermission).values({
      accountId: 99, logId: 'log-perm-a', canWrite: true, checkedAt: '2026-09-14T00:00:00.000Z',
    }).run();
    db.insert(repoPermission).values({
      accountId: 99, logId: 'log-perm-b', canWrite: false, checkedAt: '2026-09-14T00:00:00.000Z',
    }).run();

    // Verify both rows exist
    const rows = db.select().from(repoPermission).all();
    assert.equal(rows.length, 2);
  });
});

// Nitro bündelt diese Datei; danach zeigt import.meta.url nicht mehr neben
// drizzle/. Der zweite Parameter muss deshalb wirklich benutzt werden.
test('openDb reads migrations from the folder it is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-db-nomig-'));
  try {
    assert.throws(() => openDb(':memory:', dir), /_journal\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
