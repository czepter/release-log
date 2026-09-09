import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReader } from './store.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'rlh-'));
  const log = join(root, 'demo');
  mkdirSync(join(log, 'releases'), { recursive: true });
  mkdirSync(join(log, 'media'), { recursive: true });
  writeFileSync(join(log, 'release-log.json'), JSON.stringify({
    id: 'abc123', product: 'Demo', view: 'full', visibility: 'public',
  }));
  writeFileSync(join(log, 'releases', '1.0.0.json'), JSON.stringify({
    version: '1.0.0', date: '2026-02-01', published_at: '2026-02-01T00:00:00Z',
    commits: 1, headline: 'Erste Fassung', changes: [],
  }));
  writeFileSync(join(log, 'releases', '1.1.0.json'), JSON.stringify({
    version: '1.1.0', date: '2026-03-01', published_at: null,
    commits: 1, headline: 'Entwurf', changes: [],
  }));
  writeFileSync(join(log, 'releases', 'broken.json'), '{ not json');
  writeFileSync(join(log, 'media', 'shot.png'), Buffer.from([0x89, 0x50]));
  return root;
}

test('fileReader finds a log by its configured id', () => {
  const r = fileReader(fixture());
  assert.equal(r.config('abc123')?.product, 'Demo');
  assert.equal(r.config('nope'), null);
});

test('fileReader returns published and draft releases alike', () => {
  const r = fileReader(fixture());
  const versions = r.releases('abc123').map((x) => x.version).sort();
  assert.deepEqual(versions, ['1.0.0', '1.1.0']);
});

test('a broken file is skipped and reported, the rest survives', () => {
  const r = fileReader(fixture());
  assert.equal(r.releases('abc123').length, 2);
  const errors = r.errors('abc123');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].path.includes('broken.json'));
});

test('fileReader serves media by repo-relative path', () => {
  const r = fileReader(fixture());
  const blob = r.media('abc123', 'media/shot.png');
  assert.equal(blob?.type, 'image/png');
  assert.equal(blob?.bytes.length, 2);
  assert.equal(r.media('abc123', 'media/missing.png'), null);
});

test('fileReader refuses a path that escapes the log directory', () => {
  const r = fileReader(fixture());
  assert.equal(r.media('abc123', '../release-log.json'), null);
  assert.equal(r.media('abc123', 'media/../../etc/hosts'), null);
});
