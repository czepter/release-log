import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log } from './db/schema.ts';
import { dueLogs, reconcileTick } from './reconcile.ts';
import { syncQueue } from './syncQueue.ts';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

async function withDb(fn: (db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  try {
    await fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function insert(db: ReturnType<typeof openDb>, publicId: string, repo: string, indexedAt: string | null, state = 'active'): void {
  db.insert(log).values({
    publicId, repoOwner: 'o', repoName: repo, repoNodeId: `R_${publicId}`,
    product: 'P', view: 'sections', visibility: 'public', curationNotes: null,
    state, headSha: 'c0ffee', configBlobSha: 'abc', indexedAt,
  }).run();
}

test('a log that has never been indexed is due', async () => {
  await withDb(async (db) => {
    insert(db, 'never', 'never', null);
    assert.deepEqual(dueLogs(db, NOW), [{ owner: 'o', repo: 'never' }]);
  });
});

test('a log older than an hour is due, a fresh one is not', async () => {
  await withDb(async (db) => {
    insert(db, 'stale', 'stale', new Date(NOW - 61 * 60_000).toISOString());
    insert(db, 'fresh', 'fresh', new Date(NOW - 60_000).toISOString());
    insert(db, 'fresher', 'fresher', new Date(NOW - 30_000).toISOString());
    const due = dueLogs(db, NOW).map((r) => r.repo);
    assert.ok(due.includes('stale'), 'über eine Stunde alt');
    assert.ok(!due.includes('fresher'), 'gerade erst abgeglichen');
  });
});

test('the single oldest log is due even when nothing is stale', async () => {
  // Spec §4: alle fünf Minuten der Log mit dem ältesten indexed_at. Ohne
  // diese Regel täte eine Runde in einem ruhigen Bestand gar nichts.
  await withDb(async (db) => {
    insert(db, 'old', 'old', new Date(NOW - 10 * 60_000).toISOString());
    insert(db, 'new', 'new', new Date(NOW - 60_000).toISOString());
    assert.deepEqual(dueLogs(db, NOW), [{ owner: 'o', repo: 'old' }]);
  });
});

test('a frozen log is due too, which is the only way it can ever thaw', async () => {
  // Spec §10: "Repo wiederhergestellt -> der nächste erfolgreiche Abgleich
  // taut den Log von selbst auf." Ein übersprungener Log bekommt nie einen
  // nächsten Abgleich. Siehe "Abweichungen von der Spec", Punkt 1.
  await withDb(async (db) => {
    insert(db, 'frozen', 'frozen', new Date(NOW - 2 * 3_600_000).toISOString(), 'frozen');
    assert.deepEqual(dueLogs(db, NOW), [{ owner: 'o', repo: 'frozen' }]);
  });
});

test('a due log is named once, not twice, when both rules pick it', async () => {
  await withDb(async (db) => {
    insert(db, 'stale', 'stale', new Date(NOW - 5 * 3_600_000).toISOString());
    assert.equal(dueLogs(db, NOW).length, 1);
  });
});

test('every never-indexed log is due, not just the oldest', async () => {
  // The null-indexed_at branch needs its own test: a single null row cannot
  // distinguish "the null branch fires for every null row" from "only the
  // oldest-always rule happens to catch the one null row." A bulk GitHub App
  // install produces several never-synced logs at once; only the null branch
  // — not the oldest rule — makes all of them due in the same round.
  await withDb(async (db) => {
    insert(db, 'never1', 'never1', null);
    insert(db, 'never2', 'never2', null);
    insert(db, 'never3', 'never3', null);
    const due = dueLogs(db, NOW).map((r) => r.repo).sort();
    assert.deepEqual(due, ['never1', 'never2', 'never3']);
  });
});

test('an empty index has nothing due', async () => {
  await withDb(async (db) => {
    assert.deepEqual(dueLogs(db, NOW), []);
  });
});

test('a tick enqueues every due log and reports how many', async () => {
  await withDb(async (db) => {
    insert(db, 'a', 'a', null);
    insert(db, 'b', 'b', new Date(NOW - 3 * 3_600_000).toISOString());
    const seen: string[] = [];
    const q = syncQueue(async (ref) => { seen.push(ref.repo); });
    assert.equal(reconcileTick(db, q, NOW), 2);
    await q.idle();
    assert.deepEqual(seen.sort(), ['a', 'b']);
  });
});
