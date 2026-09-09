import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { log, release, syncError, problem } from './db/schema.ts';
import type { GitHub } from './github.ts';
import { fakeGitHub } from './github.ts';
import { syncLog } from './index.ts';

const REF = { owner: 'o', repo: 'r' };

function withDb(fn: (db: Db) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-idx-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  let result: Promise<void> | void;
  try {
    result = fn(openDb(join(dir, 'i.sqlite')));
  } catch (err) {
    done();
    throw err;
  }
  return result instanceof Promise ? result.finally(done) : (done(), result);
}

const CONFIG = JSON.stringify({ id: 'abc123', product: 'Demo', view: 'full', visibility: 'public' });
const RELEASE = JSON.stringify({
  version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
  commits: 1, headline: 'Erste Fassung', body: ['B'], changes: [],
});

test('the first sync registers the log and its releases', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, 'abc123');
    assert.equal(outcome.frozen, false);
    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].product, 'Demo');
    assert.equal(logs[0].repoOwner, 'o');
    assert.ok(logs[0].headSha);
    assert.ok(logs[0].indexedAt);

    const releases = db.select().from(release).all();
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '1.0.0');
    assert.equal(JSON.parse(releases[0].doc).headline, 'Erste Fassung');
  });
});

test('an invalid release file is skipped and recorded, the rest is indexed', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG,
      'releases/1.0.0.json': RELEASE,
      'releases/2.0.0.json': '{ not json',
    } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.errors, 1);
    assert.equal(db.select().from(release).all().length, 1);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('2.0.0.json'));
  });
});

test('a release whose version disagrees with its filename is an error, not a row', async () => {
  await withDb(async (db) => {
    const wrong = JSON.stringify({ ...JSON.parse(RELEASE), version: '9.9.9' });
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': wrong } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(release).all().length, 0);
    assert.equal(db.select().from(syncError).all().length, 1);
  });
});

test('a repo without release-log.json registers no log and records a problem', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'readme.md': 'nothing here' } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, null);
    assert.equal(db.select().from(log).all().length, 0);
    const problems = db.select().from(problem).all();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].message.includes('release-log.json'));
  });
});

test('an unparseable release-log.json records a problem, not a log', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{ not json' } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, null);
    assert.equal(db.select().from(log).all().length, 0);
    assert.equal(db.select().from(problem).all().length, 1);
  });
});

test('a deleted repo freezes an existing log instead of removing it', async () => {
  await withDb(async (db) => {
    const present = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    await syncLog(db, present, REF);

    const gone = fakeGitHub({});
    const outcome = await syncLog(db, gone, REF);

    assert.equal(outcome.frozen, true);
    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].state, 'frozen');
    // The last known state stays served (spec §10).
    assert.equal(db.select().from(release).all().length, 1);
  });
});

test('a repo that comes back thaws the log on the next successful sync', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({}), REF);
    assert.equal(db.select().from(log).all()[0].state, 'frozen');

    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    assert.equal(db.select().from(log).all()[0].state, 'active');
  });
});

test('a duplicate id leaves the first repository holding it untouched', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/first': files }), { owner: 'o', repo: 'first' });

    const outcome = await syncLog(db, fakeGitHub({ 'o/second': files }), { owner: 'o', repo: 'second' });

    assert.equal(outcome.logId, null);
    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].repoOwner, 'o');
    assert.equal(logs[0].repoName, 'first');
    assert.equal(db.select().from(release).all().length, 1);

    const problems = db.select().from(problem).all();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].message.includes('o/first'));
    assert.ok(problems[0].message.includes('o/second'));
    assert.ok(problems[0].message.includes('abc123'));
  });
});

test('re-syncing the repository that already holds the id is not a duplicate', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);

    assert.equal(db.select().from(log).all().length, 1);
    assert.equal(db.select().from(problem).all().length, 0);
  });
});

test('a repository that parses clears its earlier problem row', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': '{ not json' } }), REF);
    assert.equal(db.select().from(problem).all().length, 1);

    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    assert.equal(db.select().from(problem).all().length, 0);
  });
});

// Counts blob fetches so a test can prove the second sync is cheap.
function counting(gh: GitHub): { gh: GitHub; blobs: string[] } {
  const blobs: string[] = [];
  return {
    blobs,
    gh: {
      head: (ref) => gh.head(ref),
      tree: (ref, commit) => gh.tree(ref, commit),
      blob: (ref, sha) => { blobs.push(sha); return gh.blob(ref, sha); },
    },
  };
}

test('a second sync with no changes fetches nothing', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);

    const c = counting(fakeGitHub({ 'o/r': files }));
    const outcome = await syncLog(db, c.gh, REF);

    assert.equal(c.blobs.length, 0, 'no blob should be fetched when nothing changed');
    assert.equal(outcome.fetched, 0);
    assert.equal(db.select().from(release).all().length, 1);
  });
});

test('only the changed file is fetched', async () => {
  await withDb(async (db) => {
    const second = JSON.stringify({ ...JSON.parse(RELEASE), version: '2.0.0', date: '2026-02-01' });
    const before = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE, 'releases/2.0.0.json': second };
    await syncLog(db, fakeGitHub({ 'o/r': before }), REF);

    const edited = JSON.stringify({ ...JSON.parse(RELEASE), headline: 'Neu geschrieben' });
    const after = { ...before, 'releases/1.0.0.json': edited };
    const c = counting(fakeGitHub({ 'o/r': after }));
    const outcome = await syncLog(db, c.gh, REF);

    assert.equal(outcome.fetched, 1);
    assert.equal(c.blobs.length, 1);
    const rows = db.select().from(release).all();
    assert.equal(rows.length, 2);
    const one = rows.find((r) => r.version === '1.0.0');
    assert.ok(one);
    assert.equal(JSON.parse(one.doc).headline, 'Neu geschrieben');
  });
});

test('a release removed from the repo disappears from the index', async () => {
  await withDb(async (db) => {
    const second = JSON.stringify({ ...JSON.parse(RELEASE), version: '2.0.0', date: '2026-02-01' });
    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE, 'releases/2.0.0.json': second,
    } }), REF);
    assert.equal(db.select().from(release).all().length, 2);

    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE,
    } }), REF);

    const rows = db.select().from(release).all();
    assert.deepEqual(rows.map((r) => r.version), ['1.0.0']);
  });
});

test('a changed config is re-read and its settings applied', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    assert.equal(db.select().from(log).all()[0].visibility, 'public');

    const priv = JSON.stringify({ ...JSON.parse(CONFIG), visibility: 'private', view: 'timeline' });
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': priv } }), REF);

    const row = db.select().from(log).all()[0];
    assert.equal(row.visibility, 'private');
    assert.equal(row.view, 'timeline');
  });
});

test('an empty index rebuilds everything — no change is a special case', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    const c = counting(fakeGitHub({ 'o/r': files }));
    const outcome = await syncLog(db, c.gh, REF);
    // config + one release
    assert.equal(c.blobs.length, 2);
    assert.equal(outcome.fetched, 1);
  });
});

test('a good release edited into something invalid loses its release row, gains an error, and leaves other releases alone', async () => {
  await withDb(async (db) => {
    const second = JSON.stringify({ ...JSON.parse(RELEASE), version: '2.0.0', date: '2026-02-01' });
    const before = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE, 'releases/2.0.0.json': second };
    await syncLog(db, fakeGitHub({ 'o/r': before }), REF);
    assert.equal(db.select().from(release).all().length, 2);

    const broken = { ...before, 'releases/1.0.0.json': '{ not json' };
    const outcome = await syncLog(db, fakeGitHub({ 'o/r': broken }), REF);

    assert.equal(outcome.errors, 1);
    const rows = db.select().from(release).all();
    assert.deepEqual(rows.map((r) => r.version), ['2.0.0']);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('1.0.0.json'));
  });
});

test('a broken release synced again with no change fetches nothing but still counts as an error', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);

    const broken = { ...files, 'releases/1.0.0.json': '{ not json' };
    await syncLog(db, fakeGitHub({ 'o/r': broken }), REF);

    const c = counting(fakeGitHub({ 'o/r': broken }));
    const outcome = await syncLog(db, c.gh, REF);

    assert.equal(c.blobs.length, 0, 'no blob should be fetched for the same known-broken sha');
    assert.equal(outcome.errors, 1);
    assert.equal(db.select().from(release).all().length, 0);
    assert.equal(db.select().from(syncError).all().length, 1);
  });
});

test('a broken release edited into different broken content is re-fetched', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);

    const brokenOne = { ...files, 'releases/1.0.0.json': '{ not json' };
    await syncLog(db, fakeGitHub({ 'o/r': brokenOne }), REF);

    const brokenTwo = { ...files, 'releases/1.0.0.json': '{ also not json' };
    const c = counting(fakeGitHub({ 'o/r': brokenTwo }));
    const outcome = await syncLog(db, c.gh, REF);

    assert.equal(c.blobs.length, 1, 'a different broken sha must be re-fetched');
    assert.equal(outcome.fetched, 1);
    assert.equal(outcome.errors, 1);
  });
});

test('a broken release repaired gets its release row back and loses its error', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);

    const broken = { ...files, 'releases/1.0.0.json': '{ not json' };
    await syncLog(db, fakeGitHub({ 'o/r': broken }), REF);
    assert.equal(db.select().from(release).all().length, 0);
    assert.equal(db.select().from(syncError).all().length, 1);

    const repaired = JSON.stringify({ ...JSON.parse(RELEASE), headline: 'Repariert' });
    const outcome = await syncLog(db, fakeGitHub({ 'o/r': { ...files, 'releases/1.0.0.json': repaired } }), REF);

    assert.equal(outcome.errors, 0);
    const rows = db.select().from(release).all();
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].doc).headline, 'Repariert');
    assert.equal(db.select().from(syncError).all().length, 0);
  });
});
