import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { log, release, syncError, problem, media } from './db/schema.ts';
import type { GitHub } from './github.ts';
import { fakeGitHub, blobSha } from './github.ts';
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

test("changing a repository's id retires its old log, releases, media and errors", async () => {
  await withDb(async (db) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const before = {
      'release-log.json': CONFIG,
      'releases/1.0.0.json': RELEASE,
      'releases/broken.json': '{ not json',
      'media/shot.png': png,
    };
    await syncLog(db, fakeGitHub({ 'o/r': before }), REF);
    assert.equal(db.select().from(log).all().length, 1);
    assert.equal(db.select().from(release).all().length, 1);
    assert.equal(db.select().from(media).all().length, 1);
    assert.equal(db.select().from(syncError).all().length, 1);

    // Same repository, but release-log.json's id field was hand-edited.
    const newConfig = JSON.stringify({ id: 'xyz789', product: 'Demo', view: 'full', visibility: 'public' });
    const after = { ...before, 'release-log.json': newConfig };
    const outcome = await syncLog(db, fakeGitHub({ 'o/r': after }), REF);

    assert.equal(outcome.logId, 'xyz789');
    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1, 'the old id must not be left behind as an orphaned log');
    assert.equal(logs[0].publicId, 'xyz789');

    const releases = db.select().from(release).all();
    assert.equal(releases.length, 1, 'no orphaned release row under the old id');
    assert.equal(releases[0].logId, 'xyz789');

    const mediaRows = db.select().from(media).all();
    assert.equal(mediaRows.length, 1, 'no orphaned media row under the old id');
    assert.equal(mediaRows[0].logId, 'xyz789');

    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1, 'no orphaned sync_error row under the old id');
    assert.equal(errors[0].logId, 'xyz789');
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
      probe: (ref) => gh.probe(ref),
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

test('a sync that throws partway through leaves head_sha at the previous value', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    const before = db.select().from(log).all()[0];

    // A new release file moves the head and needs a blob fetch; make that
    // fetch reject, the way a rate limit or a network error would.
    const second = JSON.stringify({ ...JSON.parse(RELEASE), version: '2.0.0', date: '2026-02-01' });
    const changed = { ...files, 'releases/2.0.0.json': second };
    const base = fakeGitHub({ 'o/r': changed });
    const failing: GitHub = {
      probe: (ref) => base.probe(ref),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: async () => { throw new Error('rate limited'); },
    };

    await assert.rejects(() => syncLog(db, failing, REF));

    const after = db.select().from(log).all()[0];
    assert.equal(after.headSha, before.headSha, 'head_sha must not move until the content it names has landed');
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('a media file is indexed with its bytes and content type', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': PNG } });
    await syncLog(db, gh, REF);

    const rows = db.select().from(media).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'media/shot.png');
    assert.equal(rows[0].contentType, 'image/png');
    assert.deepEqual(Buffer.from(rows[0].bytes), PNG);
  });
});

test('an unsupported media type is not indexed and is recorded', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/notes.txt': 'hi' } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(media).all().length, 0);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('notes.txt'));
  });
});

test('a media file over the size cap is not indexed and is recorded', async () => {
  await withDb(async (db) => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/huge.png': huge } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(media).all().length, 0);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('10'));
  });
});

test('an oversized media file is never fetched, only its tree entry is read', async () => {
  await withDb(async (db) => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const c = counting(fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/huge.png': huge } }));
    await syncLog(db, c.gh, REF);
    // Only the config blob. The size comes from the tree entry, so the
    // service never pulls ten megabytes it is going to reject.
    assert.equal(c.blobs.length, 1);
  });
});

test('a media file removed from the repo disappears from the index', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': PNG } }), REF);
    assert.equal(db.select().from(media).all().length, 1);

    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    assert.equal(db.select().from(media).all().length, 0);
  });
});

// Regression: a media file that was already indexed must not go on serving
// its stale bytes once it regresses on a later sync — the same staleness
// bug the release loop was already careful to avoid. Each test below starts
// from a file that IS indexed, then regresses it, and checks the old
// `media` row is gone, not just that a `syncError` row appeared beside it.

test('an indexed media file that grows past the size cap is dropped, not left stale', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': PNG } }), REF);
    assert.equal(db.select().from(media).all().length, 1);

    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const grown = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': huge } });
    await syncLog(db, grown, REF);

    assert.equal(db.select().from(media).all().length, 0, 'the stale row must be gone, not just an error added');
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('shot.png'));
  });
});

test('an indexed media file that becomes an unsupported type is dropped, not left stale', async () => {
  await withDb(async (db) => {
    // The extension check is a pure function of the path, so no two real
    // syncs against the same path can flip a file from supported to
    // unsupported — the only way a *supported* path regresses into an
    // unsupported one is a rename, which the tree-diff sweep already
    // covers (a different test, a different code path). To reach the
    // extension-check's own delete branch, seed a media row directly, as
    // if it had been indexed under a type this codebase no longer
    // supports (or the path was reused after such a file), then let the
    // tree present that same path with an unsupported extension today.
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    db.insert(media).values({
      logId: 'abc123', path: 'media/shot.gif', blobSha: 'stalesha', contentType: 'image/gif', bytes: PNG,
    }).run();
    assert.equal(db.select().from(media).all().length, 1);

    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.gif': PNG } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(media).all().length, 0, 'the stale row must be gone, not just an error added');
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('shot.gif'));
  });
});

test('an indexed media file whose blob comes back null on a later sync is dropped, not left stale', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': PNG } }), REF);
    assert.equal(db.select().from(media).all().length, 1);

    // A different sha for the same path, so the fetch is not skipped as
    // unchanged. The fake GitHub cannot produce a missing blob for a path
    // its tree lists, so wrap it the way the fetch-counting tests do and
    // have the wrapper return null for that one blob.
    const edited = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const editedSha = blobSha(edited);
    const base = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': edited } });
    const missingBlob: GitHub = {
      probe: (ref) => base.probe(ref),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: async (ref, sha) => (sha === editedSha ? null : base.blob(ref, sha)),
    };
    await syncLog(db, missingBlob, REF);

    assert.equal(db.select().from(media).all().length, 0, 'the stale row must be gone, not just an error added');
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('shot.png'));
  });
});

test('the sync stores the repository node id', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } });
    await syncLog(db, gh, REF);
    const row = db.select().from(log).all()[0];
    // Compared against what the client actually answered, not merely
    // asserted non-empty: a hardcoded id would satisfy "not null".
    assert.equal(row.repoNodeId, (await gh.probe(REF) as { nodeId: string }).nodeId);
  });
});

test('a sync without an installation leaves the stored node id alone', async () => {
  await withDb(async (db) => {
    const base = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } });
    await syncLog(db, base, REF);
    const first = db.select().from(log).all()[0].repoNodeId;
    assert.ok(first, 'der erste Abgleich muss eine ID abgelegt haben');

    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: (ref, sha) => base.blob(ref, sha),
    };
    await syncLog(db, uninstalled, REF);
    assert.equal(db.select().from(log).all()[0].repoNodeId, first);
  });
});

test('a repository the app is not installed on is skipped, not frozen', async () => {
  await withDb(async (db) => {
    const base = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    await syncLog(db, base, REF);
    assert.equal(db.select().from(log).all()[0].state, 'active');

    // Spec §10: Installation suspendiert oder entfernt -> kein Abgleich,
    // Auslieferung läuft. Einfrieren wäre hier der teure Fehler.
    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: (ref, sha) => base.blob(ref, sha),
    };
    const outcome = await syncLog(db, uninstalled, REF);

    assert.equal(outcome.skipped, 'no_installation');
    assert.equal(outcome.frozen, false);
    assert.equal(db.select().from(log).all()[0].state, 'active', 'der Log bleibt aktiv');
    assert.equal(db.select().from(release).all().length, 1, 'und behält seinen Inhalt');
  });
});

test('a deleted repository still freezes its log', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    const outcome = await syncLog(db, fakeGitHub({}), REF);
    assert.equal(outcome.frozen, true);
    assert.equal(outcome.skipped, null);
    assert.equal(db.select().from(log).all()[0].state, 'frozen');
  });
});

test('a restored repository thaws on the next successful sync', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({}), REF);
    assert.equal(db.select().from(log).all()[0].state, 'frozen');

    // Spec §10: der nächste erfolgreiche Abgleich taut den Log von selbst auf.
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    assert.equal(db.select().from(log).all()[0].state, 'active');
  });
});

test('a repository with no commits is skipped without a problem row', async () => {
  await withDb(async (db) => {
    const empty: GitHub = {
      probe: async () => ({ kind: 'empty', nodeId: 'R_1' }),
      tree: async () => [],
      blob: async () => null,
    };
    const outcome = await syncLog(db, empty, REF);
    assert.equal(outcome.skipped, 'no_commits');
    assert.equal(outcome.logId, null);
    // Ein frisch angelegtes Repo ist noch kein kaputtes Repo.
    assert.equal(db.select().from(problem).all().length, 0);
  });
});

test('a renamed repository keeps its log, anchored on the node id', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    const before = db.select().from(log).all()[0];

    // Dasselbe Repo unter neuem Namen: gleiche Node-ID, anderer Pfad.
    const renamed: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: before.repoNodeId as string }),
      tree: async () => fakeGitHub({ 'o/r': files }).tree(REF, 'c1'),
      blob: (ref, sha) => fakeGitHub({ 'o/r': files }).blob(REF, sha),
    };
    await syncLog(db, renamed, { owner: 'o', repo: 'renamed' });

    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1, 'kein zweiter Log für dasselbe Repo');
    assert.equal(rows[0].publicId, before.publicId, 'eingebundene URLs brechen nicht');
    assert.equal(rows[0].repoName, 'renamed', 'Owner und Name ziehen nach');
  });
});
