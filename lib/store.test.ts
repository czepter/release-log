import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileReader } from './store.ts';

// Every test needs a fresh temp dir and nothing removed it on its own,
// leaving ten growing temp trees under the OS temp dir per run. Route every
// temp-dir-backed test through this so cleanup happens even on failure.
function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rlh-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function populateFixture(root: string): void {
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
  // Real escape targets, both whitelisted extensions, so the boundary check
  // (not the extension whitelist) is what has to reject them.
  writeFileSync(join(root, 'evil.png'), Buffer.from([0x89, 0x50]));
  mkdirSync(join(root, 'demo-evil'));
  writeFileSync(join(root, 'demo-evil', 'shot.png'), Buffer.from([0x89, 0x50]));
}

function withFixture(fn: (root: string) => void): void {
  withTempDir((root) => {
    populateFixture(root);
    fn(root);
  });
}

test('fileReader finds a log by its configured id', () => {
  withFixture((root) => {
    const r = fileReader(root);
    assert.equal(r.config('abc123')?.product, 'Demo');
    assert.equal(r.config('nope'), null);
  });
});

test('fileReader returns published and draft releases alike', () => {
  withFixture((root) => {
    const r = fileReader(root);
    const versions = r.releases('abc123').map((x) => x.version).sort();
    assert.deepEqual(versions, ['1.0.0', '1.1.0']);
  });
});

test('a broken file is skipped and reported, the rest survives', () => {
  withFixture((root) => {
    const r = fileReader(root);
    assert.equal(r.releases('abc123').length, 2);
    const errors = r.errors('abc123');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('broken.json'));
  });
});

test('fileReader serves media by repo-relative path', () => {
  withFixture((root) => {
    const r = fileReader(root);
    const blob = r.media('abc123', 'media/shot.png');
    assert.equal(blob?.type, 'image/png');
    assert.equal(blob?.bytes.length, 2);
    assert.equal(r.media('abc123', 'media/missing.png'), null);
  });
});

test('fileReader refuses a path that escapes the log directory', () => {
  withFixture((root) => {
    const r = fileReader(root);
    assert.equal(r.media('abc123', '../release-log.json'), null);
    assert.equal(r.media('abc123', 'media/../../etc/hosts'), null);
  });
});

test('fileReader refuses a whitelisted-extension traversal to a real file outside the log directory', () => {
  withFixture((root) => {
    const r = fileReader(root);
    // '.png' is whitelisted, so only the boundary check can reject this.
    assert.equal(r.media('abc123', '../evil.png'), null);
  });
});

test('fileReader refuses a sibling directory whose name shares the log directory as a prefix', () => {
  withFixture((root) => {
    const r = fileReader(root);
    // "demo-evil" starts with "demo": a plain startsWith(log.dir) would wrongly
    // admit this, which is why the boundary check appends the path separator.
    assert.equal(r.media('abc123', '../demo-evil/shot.png'), null);
  });
});

test('fileReader refuses a symlink inside the log directory that points outside it', () => {
  withFixture((root) => {
    symlinkSync(join(root, 'evil.png'), join(root, 'demo', 'media', 'evil-link.png'));
    const r = fileReader(root);
    assert.equal(r.media('abc123', 'media/evil-link.png'), null);
  });
});

test('fileReader skips a dangling symlink under root instead of throwing', () => {
  withFixture((root) => {
    symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'));
    assert.doesNotThrow(() => fileReader(root));
    const r = fileReader(root);
    assert.equal(r.config('abc123')?.product, 'Demo');
  });
});

test('fileReader resolves a relative root so media requests are not silently denied', () => {
  withFixture((root) => {
    // Build a path relative to cwd, not by mutating process.chdir.
    // fileReader(rootInput) calls resolve(rootInput), so a relative root is
    // resolved relative to cwd and becomes absolute. This test confirms it works
    // end-to-end: a relative path both serves logs and media successfully.
    const relativeRoot = relative(process.cwd(), root);
    const r = fileReader(relativeRoot);
    const blob = r.media('abc123', 'media/shot.png');
    assert.equal(blob?.type, 'image/png');
  });
});

test('a second directory declaring an already-taken id is not registered', () => {
  withTempDir((root) => {
    for (const name of ['first', 'second']) {
      const log = join(root, name);
      mkdirSync(join(log, 'releases'), { recursive: true });
      writeFileSync(join(log, 'release-log.json'), JSON.stringify({
        id: 'dup', product: name, view: 'full', visibility: 'public',
      }));
    }
    const r = fileReader(root);
    // Directory entries are scanned in sorted order (lexicographic),
    // so 'first' (alphabetically before 'second') is the first claimant.
    assert.equal(r.config('dup')?.product, 'first');
  });
});

test('a duplicate id produces a problem entry naming both directories and the id', () => {
  withTempDir((root) => {
    const dirs: Record<string, string> = {};
    for (const name of ['first', 'second']) {
      const log = join(root, name);
      dirs[name] = log;
      mkdirSync(join(log, 'releases'), { recursive: true });
      writeFileSync(join(log, 'release-log.json'), JSON.stringify({
        id: 'dup', product: name, view: 'full', visibility: 'public',
      }));
    }
    const r = fileReader(root);
    const problems = r.problems();
    assert.equal(problems.length, 1);
    // Names both directories, not just the one that lost.
    assert.ok(problems[0].path.includes(dirs.first));
    assert.ok(problems[0].path.includes(dirs.second));
    assert.ok(problems[0].message.includes('dup'));
  });
});

test('an invalid release-log.json produces a problem entry instead of disappearing silently', () => {
  withTempDir((root) => {
    const log = join(root, 'broken-log');
    mkdirSync(log, { recursive: true });
    writeFileSync(join(log, 'release-log.json'), '{ not json');
    const r = fileReader(root);
    // The log has no id (it never parsed), so this is unreachable through
    // errors(logId) -- it has to be on the id-less problems() channel.
    assert.equal(r.config('broken-log'), null);
    const problems = r.problems();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].path.includes('broken-log'));
  });
});
