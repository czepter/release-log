import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobSha, fakeGitHub, githubClient } from './github.ts';
import { fakeHttp } from './http.ts';
import type { Installations } from './appAuth.ts';

test('blobSha matches git hash-object for an empty blob', () => {
  // git's well-known empty-blob hash. If this drifts, the whole diff is wrong.
  assert.equal(blobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('blobSha matches git hash-object for known content', () => {
  // printf 'hello\n' | git hash-object --stdin
  assert.equal(blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('blobSha changes when the content changes by one byte', () => {
  assert.notEqual(blobSha('a'), blobSha('b'));
});

test('fakeGitHub returns a tree with a sha and size per file', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}', 'releases/1.0.0.json': 'x' } });
  const head = await gh.head({ owner: 'o', repo: 'r' });
  assert.ok(head);
  const tree = await gh.tree({ owner: 'o', repo: 'r' }, head);
  assert.deepEqual(tree.map((e) => e.path).sort(), ['release-log.json', 'releases/1.0.0.json']);
  const config = tree.find((e) => e.path === 'release-log.json');
  assert.equal(config?.sha, blobSha('{}'));
  assert.equal(config?.size, 2);
});

test('fakeGitHub serves a blob by its sha', async () => {
  const gh = fakeGitHub({ 'o/r': { 'a.txt': 'hello\n' } });
  const bytes = await gh.blob({ owner: 'o', repo: 'r' }, blobSha('hello\n'));
  assert.equal(bytes?.toString('utf8'), 'hello\n');
  assert.equal(await gh.blob({ owner: 'o', repo: 'r' }, blobSha('nope')), null);
});

test('fakeGitHub reports a missing repo as a null head', async () => {
  const gh = fakeGitHub({});
  assert.equal(await gh.head({ owner: 'o', repo: 'gone' }), null);
});

test('the head changes when any file changes', async () => {
  const before = fakeGitHub({ 'o/r': { 'a.txt': '1' } });
  const after = fakeGitHub({ 'o/r': { 'a.txt': '2' } });
  assert.notEqual(
    await before.head({ owner: 'o', repo: 'r' }),
    await after.head({ owner: 'o', repo: 'r' }),
  );
});

const REF = { owner: 'o', repo: 'r' };

function withToken(token: string | null): Installations {
  return { async tokenFor() { return token; } };
}

test('head returns the sha of the default branch tip', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  assert.equal(await githubClient(withToken('t'), http).head(REF), 'c0ffee');
});

test('head follows the repository default branch rather than assuming main', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'trunk' } },
    'GET /repos/o/r/commits/trunk': { body: { sha: 'deadbee' } },
  });
  assert.equal(await githubClient(withToken('t'), http).head(REF), 'deadbee');
});

test('a deleted repository yields a null head', async () => {
  const http = fakeHttp({});
  assert.equal(await githubClient(withToken('t'), http).head(REF), null);
});

test('a repository the app is not installed on yields a null head', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  assert.equal(await githubClient(withToken(null), http).head(REF), null);
  assert.deepEqual(http.calls, [], 'without a token there is nothing to ask');
});

test('an empty repository with no commits yields a null head', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { status: 409, body: { message: 'Git Repository is empty.' } },
  });
  assert.equal(await githubClient(withToken('t'), http).head(REF), null);
});

test('repoId returns the immutable node id', async () => {
  const http = fakeHttp({ 'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } } });
  assert.equal(await githubClient(withToken('t'), http).repoId(REF), 'R_kg1');
});

test('the request carries the installation token, not the app jwt', async () => {
  let seen: string | undefined;
  const inner = fakeHttp({ 'GET /repos/o/r': { body: { node_id: 'R_1', default_branch: 'main' } } });
  const spy = Object.assign(
    async (url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('authorization') ?? undefined;
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await githubClient(withToken('ghs_abc'), spy).repoId(REF);
  assert.equal(seen, 'Bearer ghs_abc');
});

test('fakeGitHub answers repoId for a known repository and null for an unknown one', async () => {
  const gh = fakeGitHub({ 'o/r': { 'a.txt': 'x' } });
  assert.ok(await gh.repoId({ owner: 'o', repo: 'r' }));
  assert.equal(await gh.repoId({ owner: 'o', repo: 'gone' }), null);
});

test('tree returns only blobs, with path, sha and size', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/trees/c0ffee?recursive=1': {
      body: {
        truncated: false,
        tree: [
          { path: 'releases', type: 'tree', sha: 't1' },
          { path: 'releases/1.0.0.json', type: 'blob', sha: 'b1', size: 42 },
          { path: 'media/shot.png', type: 'blob', sha: 'b2', size: 7 },
        ],
      },
    },
  });
  const entries = await githubClient(withToken('t'), http).tree(REF, 'c0ffee');
  assert.deepEqual(entries, [
    { path: 'releases/1.0.0.json', sha: 'b1', size: 42 },
    { path: 'media/shot.png', sha: 'b2', size: 7 },
  ]);
});

test('a tree that cannot be read throws instead of returning an empty one', async () => {
  const http = fakeHttp({});
  // An empty array would tell the sync that every file was deleted.
  await assert.rejects(
    () => githubClient(withToken('t'), http).tree(REF, 'c0ffee'),
    /tree lookup failed/,
  );
});

test('a tree requested without an installation throws rather than reading as empty', async () => {
  const http = fakeHttp({});
  await assert.rejects(
    () => githubClient(withToken(null), http).tree(REF, 'c0ffee'),
    /no installation token/,
  );
});

test('a truncated tree throws instead of returning a partial one', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/trees/c0ffee?recursive=1': {
      body: { truncated: true, tree: [{ path: 'a.json', type: 'blob', sha: 'b1', size: 1 }] },
    },
  });
  // A partial tree looks to the sync exactly like a repository whose other
  // files were deleted, and it would delete their rows. Refusing is the
  // only safe answer.
  await assert.rejects(
    () => githubClient(withToken('t'), http).tree(REF, 'c0ffee'),
    /truncated/,
  );
});

test('blob decodes base64 content', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/blobs/b1': {
      body: { encoding: 'base64', content: Buffer.from('hello\n', 'utf8').toString('base64') },
    },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, 'b1');
  assert.equal(bytes?.toString('utf8'), 'hello\n');
});

test('blob handles the newlines GitHub inserts into base64 content', async () => {
  const raw = Buffer.from('hello\n', 'utf8').toString('base64');
  const http = fakeHttp({
    'GET /repos/o/r/git/blobs/b1': { body: { encoding: 'base64', content: `${raw.slice(0, 2)}\n${raw.slice(2)}\n` } },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, 'b1');
  assert.equal(bytes?.toString('utf8'), 'hello\n');
});

test('a missing blob yields null', async () => {
  const http = fakeHttp({});
  assert.equal(await githubClient(withToken('t'), http).blob(REF, 'nope'), null);
});

test('an unexpected blob encoding throws rather than returning garbage', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/blobs/b1': { body: { encoding: 'utf-8', content: 'hello' } },
  });
  await assert.rejects(
    () => githubClient(withToken('t'), http).blob(REF, 'b1'),
    /encoding/,
  );
});

test('a fetched blob really hashes to the sha it was asked for', async () => {
  const content = 'version: 1\n';
  const sha = blobSha(content);
  const http = fakeHttp({
    [`GET /repos/o/r/git/blobs/${sha}`]: {
      body: { encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') },
    },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, sha);
  assert.equal(blobSha(bytes as Buffer), sha, 'the decode must round-trip to the same git hash');
});
