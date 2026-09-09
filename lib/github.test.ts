import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobSha, fakeGitHub } from './github.ts';

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
