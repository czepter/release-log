import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
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

    let treeCalled = false;
    let blobCalled = false;
    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: async (ref, commit) => { treeCalled = true; return base.tree(ref, commit); },
      blob: async (ref, sha) => { blobCalled = true; return base.blob(ref, sha); },
    };
    await syncLog(db, uninstalled, REF);

    assert.equal(db.select().from(log).all()[0].repoNodeId, first);
    // The node-id assertion above is not wrong, only insufficient: Drizzle
    // drops an `undefined` field from a SET clause instead of writing
    // NULL, so it would also pass by ORM accident if the early return
    // were removed and the sync fell through to the upsert with an
    // undefined node id. What this branch actually promises is that the
    // sync never goes on to read the repository at all — assert that
    // directly (Task 4 finding 3).
    assert.equal(treeCalled, false, 'tree() must not be called when there is no installation');
    assert.equal(blobCalled, false, 'blob() must not be called when there is no installation');
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

// Finding 3: neither branch used to advance indexed_at, so dueLogs' hourly
// staleness rule never actually applied to a frozen or skipped log — every
// one of them looked "over an hour stale" on every 5-minute reconcile
// tick, forever, not once per hour as documented. Stamping indexed_at
// makes "last looked at" the real semantics of the column here too.
test('(Finding 3) a gone repository stamps indexed_at on the row it freezes', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    // Back-date indexed_at from the full sync above so this test can
    // actually distinguish "the gone branch stamped it" from "it was
    // already recent from the sync a moment ago" — a row already fresh
    // from setup would pass the 'recent' check below whether or not the
    // gone branch does anything at all.
    const publicId = db.select().from(log).all()[0].publicId;
    db.update(log).set({ indexedAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(log.publicId, publicId)).run();
    const before = Date.now();

    await syncLog(db, fakeGitHub({}), REF);

    const row = db.select().from(log).all()[0];
    assert.equal(row.state, 'frozen');
    assert.ok(row.indexedAt, 'indexed_at must not be left null');
    const gap = Math.abs(Date.parse(row.indexedAt as string) - before);
    assert.ok(gap < 5_000, `indexed_at must be recent, was ${row.indexedAt}`);
  });
});

test('(Finding 3) a no_installation result stamps indexed_at on the existing row', async () => {
  await withDb(async (db) => {
    const base = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } });
    await syncLog(db, base, REF);
    // Same reasoning as the 'gone' test above: back-date first so a stale
    // stamp is actually distinguishable from a freshly-synced one.
    const publicId = db.select().from(log).all()[0].publicId;
    db.update(log).set({ indexedAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(log.publicId, publicId)).run();
    const before = Date.now();

    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: (ref, sha) => base.blob(ref, sha),
    };
    const outcome = await syncLog(db, uninstalled, REF);

    assert.equal(outcome.skipped, 'no_installation');
    const row = db.select().from(log).all()[0];
    assert.ok(row.indexedAt, 'indexed_at must not be left null');
    const gap = Math.abs(Date.parse(row.indexedAt as string) - before);
    assert.ok(gap < 5_000, `indexed_at must be recent, was ${row.indexedAt}`);
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

// Finding 2: GET /repos/{old}/{old} 301-redirects to a renamed repository
// and fetch follows redirects, so probe() on a STALE ref still succeeds —
// but the response body's full_name names where the repository actually
// lives now. Writing ref.owner/ref.repo back (the stale name we were
// called with) instead of that canonical name means a lost rename webhook
// makes reconcile re-assert the stale name forever. Simulate that: probe()
// reports a different canonical owner/repo than the ref syncLog is called
// with, and check the stored row converges on the canonical name.
test("a stale ref's sync converges the row on the canonical name probe() reports, not the ref it was called with", async () => {
  await withDb(async (db) => {
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: 'R_1', owner: 'o', repo: 'new-name' }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(CONFIG), size: CONFIG.length }],
      blob: async (_ref, sha) => (sha === blobSha(CONFIG) ? Buffer.from(CONFIG) : null),
    };
    const outcome = await syncLog(db, gh, { owner: 'o', repo: 'old-stale-name' });

    assert.equal(outcome.logId, 'abc123');
    const row = db.select().from(log).all()[0];
    assert.equal(row.repoOwner, 'o');
    assert.equal(row.repoName, 'new-name', 'the canonical name probe() reported, not the stale ref it was called with');
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

// Task 4 finding 1: the duplicate-id guard false-positived on a rename
// when the existing row's repo_node_id was NULL, because a row written
// before node ids were tracked can be matched by neither the node-id
// lookup nor (after the rename) the path lookup — so the guard fired
// against the row's own id. These three tests pin the guard's exact
// boundary: refuse a real collision (a), let a genuine rename through
// (b), and adopt — rather than refuse — a legacy NULL-node-id row (c).

test('(a) a genuinely different repository cannot claim an id it does not hold', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/first': files }), { owner: 'o', repo: 'first' });

    const outcome = await syncLog(db, fakeGitHub({ 'o/second': files }), { owner: 'o', repo: 'second' });

    assert.equal(outcome.logId, null);
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repoName, 'first', 'the rightful holder is untouched');
    assert.equal(db.select().from(problem).all().length, 1);
  });
});

test('(b) the rightful holder re-syncing under a new name keeps its log', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    const before = db.select().from(log).all()[0];

    const renamed: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: before.repoNodeId as string }),
      tree: async () => fakeGitHub({ 'o/r': files }).tree(REF, 'c1'),
      blob: (ref, sha) => fakeGitHub({ 'o/r': files }).blob(REF, sha),
    };
    const outcome = await syncLog(db, renamed, { owner: 'o', repo: 'renamed' });

    assert.equal(outcome.logId, before.publicId);
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repoName, 'renamed');
    assert.equal(db.select().from(problem).all().length, 0, 'the guard must not mistake a rename for a collision');
  });
});

test('(c) a claimant row with a NULL node id is adopted, not refused', async () => {
  await withDb(async (db) => {
    // The only way to produce a NULL node id today: a row written before
    // node ids were recorded. db.insert bypasses syncLog entirely to
    // stand one up directly.
    db.insert(log).values({
      publicId: 'legacy-id',
      repoOwner: 'o',
      repoName: 'r',
      product: 'Legacy',
      view: 'full',
      visibility: 'public',
      state: 'active',
    }).run();

    const config = JSON.stringify({ id: 'legacy-id', product: 'Legacy', view: 'full', visibility: 'public' });
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: 'R_new' }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(config), size: config.length }],
      blob: async (_ref, sha) => (sha === blobSha(config) ? Buffer.from(config) : null),
    };
    // Also renamed, which is exactly what a NULL node id cannot survive:
    // the node-id lookup misses (nothing yet has 'R_new') and the path
    // lookup misses too (it searches the new name, not 'o/r').
    const outcome = await syncLog(db, gh, { owner: 'o', repo: 'renamed' });

    assert.equal(outcome.logId, 'legacy-id', 'adopted, not refused as a duplicate');
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1, 'no self-collision problem, no second row');
    assert.equal(rows[0].repoNodeId, 'R_new', 'the node id is filled in on adoption');
    assert.equal(rows[0].repoName, 'renamed');
    assert.equal(db.select().from(problem).all().length, 0);
  });
});

// Task 4 finding 2: a rename landing on a path some other row already
// holds (e.g. a name freed by a repository that went away, leaving a
// frozen log behind) made the upsert throw an unhandled UNIQUE constraint
// error on (repo_owner, repo_name) instead of being recorded as a problem.
test('a repository renamed onto a name a frozen log still holds is refused, not thrown', async () => {
  await withDb(async (db) => {
    const configA = JSON.stringify({ id: 'log-a', product: 'A', view: 'full', visibility: 'public' });
    const configB = JSON.stringify({ id: 'log-b', product: 'B', view: 'full', visibility: 'public' });

    await syncLog(db, fakeGitHub({ 'o/other': { 'release-log.json': configA } }), { owner: 'o', repo: 'other' });
    const rowA = db.select().from(log).all().find((r) => r.publicId === 'log-a')!;

    await syncLog(db, fakeGitHub({ 'o/recycled': { 'release-log.json': configB } }), { owner: 'o', repo: 'recycled' });
    // The repository behind log-b is gone; its log freezes and keeps the
    // 'o/recycled' name — freeing nothing, but leaving the name occupied.
    await syncLog(db, fakeGitHub({}), { owner: 'o', repo: 'recycled' });
    assert.equal(db.select().from(log).all().find((r) => r.publicId === 'log-b')?.state, 'frozen');

    // log-a's repository (unrelated to log-b) renames into the name
    // log-b's frozen log still holds.
    const renamed: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c-renamed', nodeId: rowA.repoNodeId as string }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(configA), size: configA.length }],
      blob: async (_ref, sha) => (sha === blobSha(configA) ? Buffer.from(configA) : null),
    };
    const outcome = await syncLog(db, renamed, { owner: 'o', repo: 'recycled' });

    assert.equal(outcome.logId, null, 'refused, not thrown, and nothing indexed under the colliding name');
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 2, 'both logs survive, untouched');
    assert.equal(rows.find((r) => r.publicId === 'log-a')?.repoName, 'other', 'log-a keeps its old name; the rename was refused');
    assert.equal(rows.find((r) => r.publicId === 'log-b')?.repoName, 'recycled', 'the frozen log is untouched');
    assert.equal(db.select().from(problem).all().length, 1);
  });
});

// Task 5 finding: a rename landing on a path an ACTIVE row holds, where
// the incoming repository is a legacy row with no node id on record, made
// `known` resolve to byPath()'s hit — log-y, the active row occupying the
// path — even though log-y's own node id proves it is not us. The
// claimant guard let it through (a NULL node id is its own exemption, for
// good reason), and the recycled-name guard read "nameHolder === known"
// as "this is our own path", because both were the same byPath() lookup.
// Execution then reached the id-change cleanup and deleted log-y's log,
// releases and media outright. This is the reviewer's live reproduction.
test('a rename onto a path an active row holds does not delete that row', async () => {
  await withDb(async (db) => {
    const configY = JSON.stringify({ id: 'log-y', product: 'Y', view: 'full', visibility: 'public' });
    await syncLog(
      db,
      fakeGitHub({ 'o/target': { 'release-log.json': configY, 'releases/1.0.0.json': RELEASE } }),
      { owner: 'o', repo: 'target' },
    );
    assert.equal(db.select().from(log).all().find((r) => r.publicId === 'log-y')?.state, 'active');
    assert.equal(db.select().from(release).all().length, 1, 'log-y holds a release before the collision');

    // log-x: a legacy row with no node id on record — the only way to
    // produce one today is to write it directly, bypassing syncLog.
    db.insert(log).values({
      publicId: 'log-x',
      repoOwner: 'o',
      repoName: 'legacy-path',
      product: 'X',
      view: 'full',
      visibility: 'public',
      state: 'active',
    }).run();

    // The repository behind log-x is renamed onto 'o/target' — a path
    // log-y legitimately holds — and synced.
    const configX = JSON.stringify({ id: 'log-x', product: 'X', view: 'full', visibility: 'public' });
    const renamed: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c-renamed', nodeId: 'R_x_new' }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(configX), size: configX.length }],
      blob: async (_ref, sha) => (sha === blobSha(configX) ? Buffer.from(configX) : null),
    };
    const outcome = await syncLog(db, renamed, { owner: 'o', repo: 'target' });

    assert.equal(outcome.logId, null, 'refused, not adopted as a rename onto someone else\'s path');
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 2, 'both logs survive');
    const rowY = rows.find((r) => r.publicId === 'log-y');
    assert.ok(rowY, 'log-y is not deleted');
    assert.equal(rowY?.repoName, 'target', 'log-y keeps its path, untouched');
    assert.equal(rows.find((r) => r.publicId === 'log-x')?.repoName, 'legacy-path', 'log-x is untouched, not adopted onto the occupied path');
    assert.equal(db.select().from(release).all().length, 1, "log-y's release survives");
    assert.equal(db.select().from(problem).all().length, 1, 'the collision is recorded as a problem, not silently resolved');
  });
});

// These two pin the `pathMatch.repoNodeId === null` gate itself, not the
// guards it feeds. Distinct from (c) above: (c) renames the legacy row
// onto a NEW path, which exercises the duplicate-id guard's null
// exemption; this one keeps the path unchanged, which is what exercises
// the `known = pathMatch` branch of the gate directly. Do not merge them.
test('a legacy row synced under its own path is adopted and gets its node id filled in', async () => {
  await withDb(async (db) => {
    const config = JSON.stringify({ id: 'legacy-id', product: 'Legacy', view: 'full', visibility: 'public' });
    // A row written before node ids were recorded, standing at the path it
    // will be synced under — no rename involved. Since Finding 1, a NULL
    // node id no longer lets `known` resolve via the path match — that
    // fallback was also the hijack an unrelated repository could ride to
    // delete this row's content, so it's gone. The row is still adopted,
    // but only through the ordinary upsert-on-public_id below: every guard
    // downstream of `known` is a no-op here because the incoming config
    // carries this row's own public_id (claimant's node id is NULL, so its
    // own exemption already lets it through; nameHolder's id already
    // equals config.id). What's lost is the fetch-avoidance optimization —
    // with `known` null, configUnchanged is false and the config blob gets
    // re-fetched even though its sha hasn't changed.
    db.insert(log).values({
      publicId: 'legacy-id',
      repoOwner: 'o',
      repoName: 'r',
      product: 'Legacy',
      view: 'full',
      visibility: 'public',
      state: 'active',
      configBlobSha: blobSha(config),
    }).run();

    let configBlobFetches = 0;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: 'R_new' }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(config), size: config.length }],
      blob: async (_ref, sha) => {
        if (sha === blobSha(config)) configBlobFetches += 1;
        return sha === blobSha(config) ? Buffer.from(config) : null;
      },
    };
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, 'legacy-id', 'indexes normally, not refused');
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1, 'the same row, not a second one');
    assert.equal(rows[0].publicId, 'legacy-id');
    assert.equal(rows[0].repoNodeId, 'R_new', 'its node id is filled in on adoption');
    assert.equal(db.select().from(problem).all().length, 0);
    assert.equal(configBlobFetches, 1, 'the fetch-avoidance optimization is gone with the NULL-node-id path fallback; the row is still adopted, just via one extra fetch');
  });
});

// Finding 1 regression: with the removed `pathMatch` fallback, a NULL
// node-id row occupying a path made `known` resolve to it by path alone.
// A wholly UNRELATED repository — its own node id, its own
// release-log.json id — synced onto that same path then also resolved
// `known` to that row (nameHolder === known, so the recycled-name guard
// never fired), reached the old-id cleanup, and deleted the NULL row's
// log, releases and media outright before overwriting it with its own
// content — with outcome.failed: false and no problem row. This is the
// reviewer's live reproduction of that hijack; it must now be refused.
test('a different repository synced onto a legacy NULL-node-id row\'s path is refused, not adopted and overwritten', async () => {
  await withDb(async (db) => {
    // Legacy row: written before node-id tracking, holding a release.
    db.insert(log).values({
      publicId: 'legacy-id',
      repoOwner: 'o',
      repoName: 'r',
      product: 'Legacy',
      view: 'full',
      visibility: 'public',
      state: 'active',
    }).run();
    db.insert(release).values({
      logId: 'legacy-id',
      version: '1.0.0',
      date: '2026-01-01',
      publishedAt: '2026-01-01T00:00:00Z',
      blobSha: 'legacysha',
      path: 'releases/1.0.0.json',
      doc: JSON.stringify({ version: '1.0.0' }),
    }).run();

    // A completely different repository — its own node id, its own
    // release-log.json id — synced onto the SAME (owner, repo) the legacy
    // row occupies. Not a rename of the legacy repo: an unrelated one.
    const configOther = JSON.stringify({ id: 'other-id', product: 'Other', view: 'full', visibility: 'public' });
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: 'R_other' }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(configOther), size: configOther.length }],
      blob: async (_ref, sha) => (sha === blobSha(configOther) ? Buffer.from(configOther) : null),
    };
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, null, 'refused, not adopted and overwritten');
    assert.equal(outcome.failed, false, 'a refusal is a clean outcome, not a thrown failure');
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1, 'the legacy row survives; nothing was inserted for the other repository');
    assert.equal(rows[0].publicId, 'legacy-id', 'not overwritten with the other repository\'s id');
    assert.equal(db.select().from(release).all().length, 1, "the legacy row's release survives, untouched");
    assert.equal(db.select().from(problem).all().length, 1, 'the collision is recorded as a problem, not silently resolved');
  });
});

test('a rename onto a path a frozen row holds is refused when the incoming repository has no row of its own', async () => {
  await withDb(async (db) => {
    const configA = JSON.stringify({ id: 'log-a', product: 'A', view: 'full', visibility: 'public' });
    await syncLog(db, fakeGitHub({ 'o/frozen-holder': { 'release-log.json': configA, 'releases/1.0.0.json': RELEASE } }), { owner: 'o', repo: 'frozen-holder' });
    const rowA = db.select().from(log).all().find((r) => r.publicId === 'log-a')!;

    // The repository behind log-a is gone; its log freezes and keeps the
    // 'o/frozen-holder' name.
    await syncLog(db, fakeGitHub({}), { owner: 'o', repo: 'frozen-holder' });
    assert.equal(db.select().from(log).all().find((r) => r.publicId === 'log-a')?.state, 'frozen');

    // A different repository, fresh node id, its own public_id, nothing on
    // record — nameHolder is the frozen row, known is null.
    const configB = JSON.stringify({ id: 'log-b', product: 'B', view: 'full', visibility: 'public' });
    const incoming: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: 'R_b_new' }),
      tree: async () => [{ path: 'release-log.json', sha: blobSha(configB), size: configB.length }],
      blob: async (_ref, sha) => (sha === blobSha(configB) ? Buffer.from(configB) : null),
    };
    const outcome = await syncLog(db, incoming, { owner: 'o', repo: 'frozen-holder' });

    assert.equal(outcome.logId, null, 'refused, nothing indexed for the incoming repository');
    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1, 'no second row was created');
    const stillA = rows.find((r) => r.publicId === 'log-a');
    assert.ok(stillA, 'the frozen row is untouched');
    assert.equal(stillA?.repoName, 'frozen-holder', 'it keeps its path');
    assert.equal(stillA?.state, 'frozen');
    assert.equal(stillA?.repoNodeId, rowA.repoNodeId, 'not adopted by the incoming repository');
    assert.equal(db.select().from(release).all().length, 1, "the frozen row's release survives, nothing deleted");
    assert.equal(db.select().from(problem).all().length, 1, 'exactly one problem row');
  });
});
