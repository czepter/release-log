import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { fakeGitHub } from './github.ts';
import { syncLog } from './index.ts';
import { indexReader } from './indexReader.ts';
import { syncError } from './db/schema.ts';

const REF = { owner: 'o', repo: 'r' };
const CONFIG = JSON.stringify({ id: 'abc123', product: 'Demo', view: 'full', visibility: 'public' });
const RELEASE = JSON.stringify({
  version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
  commits: 1, headline: 'Erste Fassung', body: ['B'],
  image: { src: 'media/shot.png', alt: 'A' }, covered: ['deadbeef'],
  changes: [{ type: 'feat', scope: null, title: 'T', description: 'D', pr: null, issues: [], commit: 'c', date: '2026-01-01' }],
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function withReader(fn: (reader: ReturnType<typeof indexReader>, db: Db) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG,
      'releases/1.0.0.json': RELEASE,
      'media/shot.png': PNG,
      'releases/bad.json': '{ not json',
    } }), REF);
    await fn(indexReader(db), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config comes back for a known id and null for an unknown one', async () => {
  await withReader(async (reader) => {
    assert.equal(reader.config('abc123')?.product, 'Demo');
    assert.equal(reader.config('abc123')?.view, 'full');
    assert.equal(reader.config('nope'), null);
  });
});

test('releases come back fully parsed, covered included', async () => {
  await withReader(async (reader) => {
    const releases = reader.releases('abc123');
    assert.equal(releases.length, 1);
    assert.equal(releases[0].headline, 'Erste Fassung');
    assert.deepEqual(releases[0].covered, ['deadbeef']);
    assert.equal(releases[0].changes[0].breaking, false);
    assert.deepEqual(reader.releases('nope'), []);
  });
});

test('media comes back with its bytes and type', async () => {
  await withReader(async (reader) => {
    const blob = reader.media('abc123', 'media/shot.png');
    assert.equal(blob?.type, 'image/png');
    assert.deepEqual(blob?.bytes, PNG);
    assert.equal(reader.media('abc123', 'media/missing.png'), null);
    assert.equal(reader.media('nope', 'media/shot.png'), null);
  });
});

test('a media path cannot escape its own log', async () => {
  await withReader(async (reader) => {
    // The index keys media by exact path, so traversal is not a filesystem
    // question here — it simply misses.
    assert.equal(reader.media('abc123', '../release-log.json'), null);
    assert.equal(reader.media('abc123', 'media/../../etc/hosts'), null);
  });
});

test('errors name the broken file without leaking the internal sha prefix', async () => {
  await withReader(async (reader) => {
    const errors = reader.errors('abc123');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('bad.json'));
    assert.ok(!errors[0].message.startsWith('sha:'), 'the sha prefix is bookkeeping, not a message');
    assert.deepEqual(reader.errors('nope'), []);
  });
});

test('problems are reported per repo, not per log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    await syncLog(db, fakeGitHub({ 'x/y': { 'release-log.json': '{ not json' } }), { owner: 'x', repo: 'y' });
    const problems = indexReader(db).problems();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].path.includes('x/y'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a frozen log is still served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({}), REF);

    const reader = indexReader(db);
    assert.equal(reader.config('abc123')?.product, 'Demo');
    assert.equal(reader.releases('abc123').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stripSha passes through a message without the sha prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG,
    } }), REF);

    // Insert a syncError row directly without the sha: prefix
    const messageWithoutPrefix = 'File is not valid JSON';
    db.insert(syncError).values({
      logId: 'abc123',
      path: 'releases/broken.json',
      message: messageWithoutPrefix,
      at: new Date().toISOString(),
    }).run();

    const reader = indexReader(db);
    const errors = reader.errors('abc123');
    const found = errors.find((e) => e.path.includes('broken.json'));
    assert.ok(found, 'should find the directly-inserted error');
    assert.equal(found.message, messageWithoutPrefix, 'message without prefix should pass through unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stripSha leaves a message alone when the sha-shaped sequence is not at the start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG,
    } }), REF);

    // The embedded sequence is shaped exactly like the real prefix (`sha:`
    // plus 40 lowercase hex characters plus one space) but sits mid-message,
    // not at the start. The anchor must keep this whole message intact.
    const messageWithShaMidString =
      'File processing failed. Reference commit sha:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef was already applied, so this is a duplicate.';
    db.insert(syncError).values({
      logId: 'abc123',
      path: 'releases/other.json',
      message: messageWithShaMidString,
      at: new Date().toISOString(),
    }).run();

    const reader = indexReader(db);
    const errors = reader.errors('abc123');
    const found = errors.find((e) => e.path.includes('other.json'));
    assert.ok(found, 'should find the error with the sha-shaped sequence mid-message');
    assert.equal(found.message, messageWithShaMidString, 'message must come back byte for byte, untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
