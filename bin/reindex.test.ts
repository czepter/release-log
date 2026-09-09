import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db/client.ts';
import { log, release } from '../lib/db/schema.ts';
import { fakeGitHub } from '../lib/github.ts';
import { reindex } from './reindex.ts';

const CONFIG = JSON.stringify({ id: 'abc123', product: 'Demo', view: 'full', visibility: 'public' });
const RELEASE = JSON.stringify({
  version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
  commits: 1, headline: 'H', body: [], changes: [],
});

test('reindex syncs every repo it is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const other = JSON.stringify({ id: 'def456', product: 'Other', view: 'full', visibility: 'public' });
    const gh = fakeGitHub({
      'o/one': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE },
      'o/two': { 'release-log.json': other },
    });

    const outcomes = await reindex(db, gh, [
      { owner: 'o', repo: 'one' },
      { owner: 'o', repo: 'two' },
    ]);

    assert.deepEqual(outcomes.map((o) => o.logId), ['abc123', 'def456']);
    assert.equal(db.select().from(log).all().length, 2);
    assert.equal(db.select().from(release).all().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reindex rebuilds an emptied index from the repos alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const path = join(dir, 'i.sqlite');
    const gh = fakeGitHub({ 'o/one': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    const refs = [{ owner: 'o', repo: 'one' }];

    await reindex(openDb(path), gh, refs);
    const before = openDb(path).select().from(release).all();

    // Delete the file and start over: the index is a derivation, so this
    // must reproduce it exactly (spec §8 litmus test).
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    await reindex(openDb(path), gh, refs);
    const after = openDb(path).select().from(release).all();

    assert.equal(after.length, before.length);
    assert.equal(after[0].doc, before[0].doc);
    assert.equal(after[0].blobSha, before[0].blobSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one failing repo does not stop the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const gh = fakeGitHub({ 'o/good': { 'release-log.json': CONFIG } });

    const outcomes = await reindex(db, gh, [
      { owner: 'o', repo: 'gone' },
      { owner: 'o', repo: 'good' },
    ]);

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].logId, null);
    assert.equal(outcomes[1].logId, 'abc123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
