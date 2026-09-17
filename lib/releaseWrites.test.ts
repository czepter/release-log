import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { log, release } from './db/schema.ts';
import { permissions } from './permissions.ts';
import type { GitHub, RepoRef } from './github.ts';
import { writeRelease, setPublished } from './releaseWrites.ts';

// Das Verhalten beider Funktionen ist über lib/mcpTools.test.ts vollständig
// abgedeckt (jeder Fehlerzweig). Hier steht nur, was die Web-API darüber
// hinaus braucht: den strukturierten Konfliktstand und den tatsächlich
// committeten Inhalt.

const DOC = {
  version: '1.0.0', date: '2026-09-01', headline: 'Erste Version', body: [],
  changes: [{ type: 'feat', title: 'Suche', description: 'x', commit: 'a', date: '2026-09-01' }],
};

type Put = { path: string; content: string; expectedSha: string | null };

function withDeps(fn: (db: Db, run: { puts: Put[]; writes: RepoRef[]; deps: Parameters<typeof writeRelease>[0] }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-writes-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const puts: Put[] = [];
  const writes: RepoRef[] = [];
  const gh: GitHub = {
    probe: async () => ({ kind: 'ready', head: 'h', nodeId: 'R1' }), tree: async () => [], blob: async () => null,
    collaboratorPermission: async () => 'write',
    async putFile(_ref, path, content, _message, expectedSha) {
      puts.push({ path, content: content.toString('utf8'), expectedSha });
      return { kind: 'committed', sha: 'newsha' };
    },
  };
  db.insert(log).values({
    publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
    view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'h',
    configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
  }).run();
  const deps = { db, perms: permissions(db, gh), gh, onRepoWrite: (ref: RepoRef) => { writes.push(ref); }, baseUrl: 'https://example.test' };
  return fn(db, { puts, writes, deps }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const who = { accountId: 42, login: 'octocat' };

test('writeRelease on an existing version without a base returns the current document, structured', async () => {
  await withDeps(async (db, { puts, deps }) => {
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'cur',
      path: 'releases/1.0.0.json', doc: JSON.stringify({ ...DOC, headline: 'Stand im Repo' }),
    }).run();
    const result = await writeRelease(deps, who, 'log1', '1.0.0', DOC, null);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'conflict');
    assert.equal(result.current?.blobSha, 'cur');
    assert.equal((result.current?.document as { headline: string }).headline, 'Stand im Repo');
    assert.equal(puts.length, 0);
  });
});

test('writeRelease commits the parsed document to releases/<version>.json with the given base', async () => {
  await withDeps(async (_db, { puts, writes, deps }) => {
    const result = await writeRelease(deps, who, 'log1', '1.0.0', DOC, 'base');
    assert.deepEqual(result, { ok: true, commitSha: 'newsha', permalink: 'https://example.test/l/log1/r/1.0.0' });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, 'releases/1.0.0.json');
    assert.equal(puts[0].expectedSha, 'base');
    // Geparst, nicht roh: Vorgaben wie covered: [] stehen im Commit.
    assert.deepEqual(JSON.parse(puts[0].content).covered, []);
    assert.deepEqual(writes, [{ owner: 'o', repo: 'repo1' }]);
  });
});

test('setPublished commits published_at against the known blob sha', async () => {
  await withDeps(async (db, { puts, deps }) => {
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'known',
      path: 'releases/1.0.0.json', doc: JSON.stringify({ ...DOC, published_at: null }),
    }).run();
    const result = await setPublished(deps, who, 'log1', '1.0.0', '2026-09-16T10:00:00Z');
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(puts[0].content).published_at, '2026-09-16T10:00:00Z');
    assert.equal(puts[0].expectedSha, 'known');
  });
});
