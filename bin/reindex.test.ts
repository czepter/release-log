import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db/client.ts';
import type { Db } from '../lib/db/client.ts';
import { log, release, media, syncError, problem } from '../lib/db/schema.ts';
import { fakeGitHub } from '../lib/github.ts';
import type { GitHub } from '../lib/github.ts';
import { reindex, buildClient } from './reindex.ts';
import { fakeHttp } from '../lib/http.ts';

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

// Strips the volatile timestamp columns (indexed_at, at) so two separate
// reindex runs can be compared for equality — the timestamps legitimately
// differ between runs even when everything else must not.
function strip<T extends Record<string, unknown>>(rows: T[], omit: string[]): unknown[] {
  return rows.map((row) => {
    const clone: Record<string, unknown> = { ...row };
    for (const key of omit) delete clone[key];
    return clone;
  });
}

function dump(db: Db) {
  return {
    log: strip(db.select().from(log).all(), ['indexedAt']),
    release: db.select().from(release).all(),
    media: db.select().from(media).all(),
    syncError: strip(db.select().from(syncError).all(), ['at']),
    problem: strip(db.select().from(problem).all(), ['at']),
  };
}

test('reindex rebuilds an emptied index from the repos alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const path = join(dir, 'i.sqlite');
    // A fixture rich enough to populate every table: a valid release, a
    // media file, a broken release file (log + release + media +
    // sync_error), and a second repository with no release-log.json
    // (problem) — comparing all five tables, not release alone, is what
    // would have caught an id-orphan bug like the one fixed in lib/index.ts.
    const gh = fakeGitHub({
      'o/one': {
        'release-log.json': CONFIG,
        'releases/1.0.0.json': RELEASE,
        'releases/broken.json': '{ not json',
        'media/shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
      'o/two': { 'readme.md': 'no release-log.json here' },
    });
    const refs = [{ owner: 'o', repo: 'one' }, { owner: 'o', repo: 'two' }];

    await reindex(openDb(path), gh, refs);
    const before = dump(openDb(path));
    assert.ok(before.log.length > 0, 'fixture must populate log');
    assert.ok(before.release.length > 0, 'fixture must populate release');
    assert.ok(before.media.length > 0, 'fixture must populate media');
    assert.ok(before.syncError.length > 0, 'fixture must populate sync_error');
    assert.ok(before.problem.length > 0, 'fixture must populate problem');

    // Delete the file and start over: the index is a derivation, so this
    // must reproduce it exactly (spec §8 litmus test) — across every
    // table, not release alone.
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    await reindex(openDb(path), gh, refs);
    const after = dump(openDb(path));

    assert.deepEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing repository does not stop the others', async () => {
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
    // A missing repository is a clean "nothing to do", not a failure:
    // syncLog handles head() returning null on its own and returns
    // normally, so this never reaches reindex's catch.
    assert.equal(outcomes[0].failed, false);
    assert.equal(outcomes[1].logId, 'abc123');
    assert.equal(outcomes[1].failed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository whose sync throws does not stop the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const base = fakeGitHub({ 'o/good': { 'release-log.json': CONFIG } });
    // Unlike a repo that is simply gone (probe() answers 'gone' and syncLog
    // handles it), this simulates GitHub answering with an error — e.g. a
    // 500 or a rate limit — which syncLog does not catch and lets
    // propagate.
    const gh: GitHub = {
      probe: async (ref) => {
        if (ref.repo === 'bad') throw new Error('500 from upstream');
        return base.probe(ref);
      },
      tree: (ref, commit) => base.tree(ref, commit),
      blob: (ref, sha) => base.blob(ref, sha),
    };

    const outcomes = await reindex(db, gh, [
      { owner: 'o', repo: 'bad' },
      { owner: 'o', repo: 'good' },
    ]);

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].failed, true, 'a thrown sync must be recorded as failed, not silently dropped');
    assert.equal(outcomes[0].logId, null);
    assert.equal(outcomes[1].logId, 'abc123', 'the repo after the throwing one must still sync');
    assert.equal(outcomes[1].failed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PEM_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_WEBHOOK_SECRET: 'shhh',
  BASE_URL: 'https://example.test',
};

test('buildClient produces a GitHub client that talks through the given http', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const env = { ...PEM_ENV, GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey, 'utf8').toString('base64') };
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': {
      body: { token: 'ghs_abc', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    },
    'GET /repos/o/r': { body: { node_id: 'R_1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });

  // Wrapped, because fakeHttp.calls deliberately records method and path
  // only — never a header. The token has to be caught on the way past.
  const auth: string[] = [];
  const watched = Object.assign(
    (url: string, init?: RequestInit) => {
      auth.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''));
      return http(url, init);
    },
    { calls: http.calls },
  );

  const gh = buildClient(env, watched);
  const state = await gh.probe({ owner: 'o', repo: 'r' });
  assert.equal(state.kind === 'ready' && state.head, 'c0ffee');

  // Returning the right sha proves nothing on its own: a client built over
  // the global fetch could not have produced it, but a stub ignoring both
  // arguments could. What pins the wiring down is that every request went
  // through the injected http, in order, and that the data calls carried the
  // token minted from the config that was passed in.
  assert.deepEqual(http.calls, [
    'GET /repos/o/r/installation',
    'POST /app/installations/7/access_tokens',
    'GET /repos/o/r',
    'GET /repos/o/r/commits/main',
  ]);
  // Who each request authenticates as: the app's own JWT to find the
  // installation and to mint, the installation token for repository data.
  // The installation id is resolved once and memoized — the second data
  // call reuses it rather than looking it up again.
  const asWhom = auth.map((value) => (value === 'Bearer ghs_abc' ? 'token' : 'jwt'));
  assert.deepEqual(asWhom, ['jwt', 'jwt', 'token', 'token']);
  assert.ok(auth[0].startsWith('Bearer eyJ'), 'the app authenticates with its own signed jwt');
});

test('buildClient reports a missing environment rather than failing later', () => {
  assert.throws(() => buildClient({ GITHUB_APP_ID: '1' }, fakeHttp({})), /GITHUB_APP_PRIVATE_KEY/);
});

test('reindex reports a repository the app is not installed on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: async () => [],
      blob: async () => null,
    };
    const [outcome] = await reindex(db, uninstalled, [{ owner: 'o', repo: 'r' }]);
    assert.equal(outcome.skipped, 'no_installation');
    assert.equal(outcome.failed, false, 'missing installation is not a failure');
    assert.equal(outcome.frozen, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
