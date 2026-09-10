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
  const state = await gh.probe({ owner: 'o', repo: 'r' });
  const head = state.kind === 'ready' ? state.head : null;
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

const REF = { owner: 'o', repo: 'r' };

function withToken(token: string | null): Installations {
  return { async tokenFor() { return token; } };
}

test('probe reports ready with the head and the node id in one call', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  const state = await githubClient(withToken('t'), http).probe(REF);
  assert.deepEqual(state, { kind: 'ready', head: 'c0ffee', nodeId: 'R_kg1' });
  // Two requests, not three: the repo call already carries the node id.
  assert.deepEqual(http.calls, ['GET /repos/o/r', 'GET /repos/o/r/commits/main']);
});

test('probe follows the repository default branch, not a hardcoded main', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'trunk' } },
    'GET /repos/o/r/commits/trunk': { body: { sha: 'deadbee' } },
  });
  const state = await githubClient(withToken('t'), http).probe(REF);
  assert.equal(state.kind === 'ready' && state.head, 'deadbee');
});

test('a deleted repository probes as gone, which is what freezes a log', async () => {
  const http = fakeHttp({});
  assert.deepEqual(await githubClient(withToken('t'), http).probe(REF), { kind: 'gone' });
});

test('a repository the app is not installed on probes as no_installation, never as gone', async () => {
  // The distinction carries spec §10: a removed installation means no sync
  // while delivery keeps going, a deleted repository means frozen. Mapping
  // both to 'gone' would freeze a log on every revoked grant.
  const http = fakeHttp({});
  assert.deepEqual(await githubClient(withToken(null), http).probe(REF), { kind: 'no_installation' });
  assert.deepEqual(http.calls, [], 'without a token there is nothing to ask');
});

test('a repository with no commits probes as empty and keeps its node id', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { status: 409 },
  });
  assert.deepEqual(await githubClient(withToken('t'), http).probe(REF), { kind: 'empty', nodeId: 'R_kg1' });
});

test('a default branch that is not there yet is empty, not gone', async () => {
  // A repository whose default branch is mid-rename answers 404 on the
  // commit call. The repository itself exists — freezing it would be the
  // expensive mistake, since a frozen log only thaws through another
  // successful sync.
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { status: 404 },
  });
  assert.deepEqual(await githubClient(withToken('t'), http).probe(REF), { kind: 'empty', nodeId: 'R_kg1' });
});

test('probe carries the installation token, not the app jwt', async () => {
  const seen: string[] = [];
  const inner = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  const spy = Object.assign(
    (url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''));
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await githubClient(withToken('ghs_abc'), spy).probe(REF);
  assert.deepEqual(seen, ['Bearer ghs_abc', 'Bearer ghs_abc']);
});

test('fakeGitHub probes a repo it knows as ready and one it does not as gone', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}' } });
  const ready = await gh.probe({ owner: 'o', repo: 'r' });
  assert.equal(ready.kind, 'ready');
  assert.ok(ready.kind === 'ready' && ready.head.length === 40, 'a head looks like a commit');
  assert.ok(ready.kind === 'ready' && ready.nodeId, 'and carries a node id');
  assert.deepEqual(await gh.probe({ owner: 'o', repo: 'gone' }), { kind: 'gone' });
});

test('fakeGitHub moves its head when content changes', async () => {
  const before = fakeGitHub({ 'o/r': { 'a.json': '{"v":1}' } });
  const after = fakeGitHub({ 'o/r': { 'a.json': '{"v":2}' } });
  const a = await before.probe({ owner: 'o', repo: 'r' });
  const b = await after.probe({ owner: 'o', repo: 'r' });
  assert.notEqual(a.kind === 'ready' && a.head, b.kind === 'ready' && b.head);
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

test('a 404 blob throws rather than returning null', async () => {
  // A blob named by a tree GitHub just served cannot legitimately be
  // absent: a 404 here means lost access or a transient failure, not a
  // deleted file. Returning null would read to the sync as "drop this
  // file's row" (spec §10) and the loss would be permanent.
  const http = fakeHttp({});
  await assert.rejects(
    () => githubClient(withToken('t'), http).blob(REF, 'nope'),
    /blob fetch failed/,
  );
});

test('a blob requested without an installation throws rather than reading as missing', async () => {
  const http = fakeHttp({});
  await assert.rejects(
    () => githubClient(withToken(null), http).blob(REF, 'nope'),
    /no installation token/,
  );
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

test('a blob of arbitrary bytes round-trips, not just ascii', async () => {
  // A release log holds screenshots. Every ASCII test above passes with a
  // decoder that mangles the high half of the byte range, so push all 256
  // values through and compare the git hash on both sides.
  const content = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ]);
  const sha = blobSha(content);
  const http = fakeHttp({
    [`GET /repos/o/r/git/blobs/${sha}`]: {
      body: { encoding: 'base64', content: content.toString('base64') },
    },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, sha);
  assert.ok(bytes !== null, 'the blob must be found');
  assert.deepEqual(bytes, content, 'every byte must survive the decode');
  assert.equal(blobSha(bytes as Buffer), sha);
});
