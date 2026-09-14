import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log } from './db/schema.ts';
import type { GitHub, RepoRef } from './github.ts';
import { permissions } from './permissions.ts';

const REF: RepoRef = { owner: 'o', repo: 'r' };

function withDb(fn: (db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-perm-'));
  return fn(openDb(join(dir, 'test.sqlite'))).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function insertLog(db: ReturnType<typeof openDb>, publicId: string, owner: string, repo: string): void {
  db.insert(log).values({
    publicId, repoOwner: owner, repoName: repo, product: 'P',
    view: 'full', visibility: 'public', curationNotes: null,
    state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
  }).run();
}

// Ein GitHub-Double, das zählt, wie oft es tatsächlich gefragt wurde — das
// ist die Assertion, die trägt: was `canWrite` zurückgibt, wäre auch mit
// einem Cache gleich, der nie greift.
function counting(level: 'admin' | 'write' | 'read' | 'none' | null): { gh: GitHub; calls: () => number } {
  let calls = 0;
  const gh: GitHub = {
    probe: async () => ({ kind: 'gone' }),
    tree: async () => [],
    blob: async () => null,
    async collaboratorPermission() { calls += 1; return level; },
  };
  return { gh, calls: () => calls };
}

test('write or admin grants canWrite, read or none does not', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const cases = [['admin', true], ['write', true], ['read', false], ['none', false]] as const;
    // Distinct accountId per case: same account/log would hit the five-
    // minute cache from the previous iteration instead of asking this
    // iteration's GitHub double, which is not what this test checks.
    for (const [i, [level, expected]] of cases.entries()) {
      const { gh } = counting(level);
      const perms = permissions(db, gh);
      assert.equal(await perms.canWrite(i + 1, 'alice', 'log1', REF), expected, `level ${level}`);
    }
  });
});

test('a null level (no signal from GitHub) is treated as no access', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh } = counting(null);
    assert.equal(await permissions(db, gh).canWrite(1, 'alice', 'log1', REF), false);
  });
});

test('a second call within five minutes does not ask GitHub again', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    let clock = 1_000_000;
    const perms = permissions(db, gh, () => clock);
    assert.equal(await perms.canWrite(1, 'alice', 'log1', REF), true);
    clock += 60_000;
    assert.equal(await perms.canWrite(1, 'alice', 'log1', REF), true);
    assert.equal(calls(), 1, 'the second call must be served from the cache');
  });
});

test('a call after five minutes asks GitHub again', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    let clock = 1_000_000;
    const perms = permissions(db, gh, () => clock);
    await perms.canWrite(1, 'alice', 'log1', REF);
    clock += 5 * 60_000 + 1;
    await perms.canWrite(1, 'alice', 'log1', REF);
    assert.equal(calls(), 2, 'the cache must expire after five minutes');
  });
});

test('two different accounts on the same log are cached separately', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    const perms = permissions(db, gh, () => 1_000_000);
    await perms.canWrite(1, 'alice', 'log1', REF);
    await perms.canWrite(2, 'bob', 'log1', REF);
    assert.equal(calls(), 2, 'a cache hit for one account must not answer for another');
  });
});

test('invalidate clears the cache for every account on that log, keyed by repository', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    const perms = permissions(db, gh, () => 1_000_000);
    await perms.canWrite(1, 'alice', 'log1', REF);
    await perms.canWrite(2, 'bob', 'log1', REF);
    perms.invalidate(REF);
    await perms.canWrite(1, 'alice', 'log1', REF);
    await perms.canWrite(2, 'bob', 'log1', REF);
    assert.equal(calls(), 4, 'both accounts must be re-checked, not just the one the event happened to name');
  });
});

test('invalidate on a repository with no log is a no-op, not a throw', async () => {
  await withDb(async (db) => {
    const { gh } = counting(null);
    permissions(db, gh).invalidate({ owner: 'nobody', repo: 'here' });
  });
});
