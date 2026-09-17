import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { blobSha, fakeGitHub, githubClient, userRepoCreator, userInstalledRepos } from './github.ts';
import { fakeHttp } from './http.ts';
import { installations } from './appAuth.ts';
import type { Installations } from './appAuth.ts';

const TEST_PEM = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

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
  return { async tokenFor() { return token; }, invalidate() {} };
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

test('a 401 invalidates the token and the request is retried once', async () => {
  // GitHub kann ein Token vor seinem genannten Ablauf töten. Ohne diesen
  // Pfad läge das tote Token bis zu einer Stunde im Cache und jeder
  // Abgleich dieser Installation schlüge fehl.
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': [
      { body: { token: 'dead', expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
      { body: { token: 'fresh', expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
    ],
    'GET /repos/o/r': [
      { status: 401 },
      { body: { node_id: 'R_kg1', default_branch: 'main' } },
    ],
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  const inst = installations(
    { appId: '12345', privateKey: TEST_PEM, webhookSecret: 'shhh', baseUrl: 'https://example.test', clientId: 'Iv1.test', clientSecret: 'test-secret', signingKey: 'test-key', tokenEncryptionKey: Buffer.alloc(32, 7), adminLogins: ['tester'], openSignup: false, maxLogsPerOwner: 10 },
    http,
  );
  const state = await githubClient(inst, http).probe(REF);
  assert.equal(state.kind, 'ready');
  const mints = http.calls.filter((c) => c === 'POST /app/installations/7/access_tokens');
  assert.equal(mints.length, 2, 'das tote Token wurde weggeworfen und ein neues geprägt');
});

test('a 401 that survives the retry is reported, not retried forever', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': {
      body: { token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    },
    'GET /repos/o/r': { status: 401 },
  });
  const inst = installations(
    { appId: '12345', privateKey: TEST_PEM, webhookSecret: 'shhh', baseUrl: 'https://example.test', clientId: 'Iv1.test', clientSecret: 'test-secret', signingKey: 'test-key', tokenEncryptionKey: Buffer.alloc(32, 7), adminLogins: ['tester'], openSignup: false, maxLogsPerOwner: 10 },
    http,
  );
  await assert.rejects(() => githubClient(inst, http).probe(REF), /HTTP 401/);
  const repoCalls = http.calls.filter((c) => c === 'GET /repos/o/r');
  assert.equal(repoCalls.length, 2, 'genau ein Wiederholungsversuch, nicht mehr');
});

test('collaboratorPermission maps the response to the four known levels', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/collaborators/alice/permission': { body: { permission: 'write' } },
  });
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, 'write');
});

test('an unrecognised permission value normalises to none, not a throw', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/collaborators/alice/permission': { body: { permission: 'triage' } },
  });
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, 'none');
});

test('a 404 on the collaborator lookup yields null, not a throw', async () => {
  const http = fakeHttp({});
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, null);
});

test('no installation token yields null, without a request', async () => {
  const http = fakeHttp({});
  const level = await githubClient(withToken(null), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, null);
  assert.deepEqual(http.calls, []);
});

test('an unexpected server error throws rather than reading as no access', async () => {
  const http = fakeHttp({ 'GET /repos/o/r/collaborators/alice/permission': { status: 500 } });
  await assert.rejects(
    () => githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice'),
    /HTTP 500/,
  );
});

test('a login with characters a URL path cannot carry raw is encoded', async () => {
  // A space alone would not distinguish this: WHATWG URL percent-encodes a
  // raw space on its own, so that fixture passes whether or not the code
  // calls encodeURIComponent. A slash does distinguish it -- left raw, it
  // re-segments the request path and the lookup silently 404s to null
  // instead of reaching the fixed route below.
  const http = fakeHttp({
    'GET /repos/o/r/collaborators/a%2Fb/permission': { body: { permission: 'admin' } },
  });
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'a/b');
  assert.equal(level, 'admin');
});

test('fakeGitHub grants write on a repository it knows, null on one it does not', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}' } });
  assert.equal(await gh.collaboratorPermission({ owner: 'o', repo: 'r' }, 'anyone'), 'write');
  assert.equal(await gh.collaboratorPermission({ owner: 'o', repo: 'gone' }, 'anyone'), null);
});

test('putFile commits new content and returns the new blob sha', async () => {
  const http = fakeHttp({
    'PUT /repos/o/r/contents/release-log.json': { body: { content: { sha: 'new-sha-abc' } } },
  });
  const result = await githubClient(withToken('t'), http).putFile(
    REF, 'release-log.json', Buffer.from('{"a":1}', 'utf8'), 'update settings', 'old-sha-123',
  );
  assert.deepEqual(result, { kind: 'committed', sha: 'new-sha-abc' });
});

test('putFile sends the content base64-encoded, with the message and expected sha', async () => {
  const http = fakeHttp({
    'PUT /repos/o/r/contents/media/shot.png': { body: { content: { sha: 'x' } } },
  });
  let sentBody: unknown;
  const spy = Object.assign(
    (url: string, init?: RequestInit) => {
      if (init?.body) sentBody = JSON.parse(String(init.body));
      return http(url, init);
    },
    { calls: http.calls },
  );
  await githubClient(withToken('t'), spy).putFile(REF, 'media/shot.png', Buffer.from([0x89, 0x50]), 'add media/shot.png', null);
  assert.deepEqual(sentBody, {
    message: 'add media/shot.png',
    content: Buffer.from([0x89, 0x50]).toString('base64'),
  });
});

test('putFile omits sha from the request when expectedSha is null, creating a new file', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/new.json': { body: { content: { sha: 'x' } } } });
  let sentBody: { sha?: string } = {};
  const spy = Object.assign(
    (url: string, init?: RequestInit) => {
      if (init?.body) sentBody = JSON.parse(String(init.body));
      return http(url, init);
    },
    { calls: http.calls },
  );
  await githubClient(withToken('t'), spy).putFile(REF, 'new.json', Buffer.from('{}'), 'msg', null);
  assert.equal('sha' in sentBody, false, 'a null expectedSha must not send a sha field at all');
});

test('a 409 (sha mismatch) is a conflict, not a throw', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/release-log.json': { status: 409 } });
  const result = await githubClient(withToken('t'), http).putFile(REF, 'release-log.json', Buffer.from('{}'), 'm', 'stale-sha');
  assert.deepEqual(result, { kind: 'conflict' });
});

test('a 422 (path already exists on a create) is also a conflict', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/media/existing.png': { status: 422 } });
  const result = await githubClient(withToken('t'), http).putFile(REF, 'media/existing.png', Buffer.from('x'), 'm', null);
  assert.deepEqual(result, { kind: 'conflict' });
});

test('no installation token yields no_installation, without a request', async () => {
  const http = fakeHttp({});
  const result = await githubClient(withToken(null), http).putFile(REF, 'release-log.json', Buffer.from('{}'), 'm', 'sha');
  assert.deepEqual(result, { kind: 'no_installation' });
  assert.deepEqual(http.calls, []);
});

test('an unexpected server error throws rather than reading as a conflict', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/release-log.json': { status: 500 } });
  await assert.rejects(
    () => githubClient(withToken('t'), http).putFile(REF, 'release-log.json', Buffer.from('{}'), 'm', 'sha'),
    /HTTP 500/,
  );
});

test('a path with a slash is percent-encoded per segment, not as one opaque string', async () => {
  const http = fakeHttp({
    'PUT /repos/o/r/contents/media/a%20b.png': { body: { content: { sha: 'x' } } },
  });
  const result = await githubClient(withToken('t'), http).putFile(REF, 'media/a b.png', Buffer.from('x'), 'm', null);
  assert.equal(result.kind, 'committed');
});

test('fakeGitHub commits and reports it in the fake repo it knows', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}' } });
  const result = await gh.putFile({ owner: 'o', repo: 'r' }, 'release-log.json', Buffer.from('{}'), 'm', 'anysha');
  assert.equal(result.kind, 'committed');
});

// userRepoCreator ist der eine Aufruf ohne Installations-Token: POST
// /user/repos gibt es nur für Nutzer-Token (spec §5, Entscheidung 23).
test('userRepoCreator posts to /user/repos with the user token and no auto_init', async () => {
  const seen: Array<{ url: string; auth: string; body: unknown }> = [];
  const inner = fakeHttp({
    'POST /user/repos': { status: 201, body: { name: 'auri-release-log', node_id: 'R_new', owner: { login: 'octocat' } } },
  });
  const http = Object.assign(
    (url: string, init?: RequestInit) => {
      seen.push({
        url,
        auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  const result = await userRepoCreator(http)('gho_user_token', {
    name: 'auri-release-log', description: 'Release-Log: Auri CRM', private: true,
  });
  assert.deepEqual(result, { kind: 'created', owner: 'octocat', repo: 'auri-release-log', nodeId: 'R_new' });
  assert.ok(seen[0].url.startsWith('https://api.github.com/'), `expected an api.github.com URL, got ${seen[0].url}`);
  assert.equal(seen[0].auth, 'Bearer gho_user_token', 'the USER token, not an installation token');
  const body = seen[0].body as { auto_init: boolean; private: boolean; name: string };
  assert.equal(body.auto_init, false, 'the first commit is ours, not GitHub\'s template');
  assert.equal(body.private, true);
  assert.equal(body.name, 'auri-release-log');
});

test('userRepoCreator reads the repository name back from the answer, not from the request', async () => {
  // GitHub normalisiert Namen (Leerzeichen werden zu Bindestrichen). Was
  // danach gilt, ist was zurückkommt.
  const http = fakeHttp({
    'POST /user/repos': { status: 201, body: { name: 'my-log', node_id: 'R_new', owner: { login: 'octocat' } } },
  });
  const result = await userRepoCreator(http)('t', { name: 'my log', description: '', private: false });
  assert.equal(result.kind === 'created' && result.repo, 'my-log');
});

test('userRepoCreator maps 422, 401/403 and a 5xx to three different answers', async () => {
  const cases: Array<[number, string]> = [[422, 'name_taken'], [401, 'unauthorized'], [403, 'unauthorized'], [503, 'unavailable']];
  for (const [status, kind] of cases) {
    const http = fakeHttp({ 'POST /user/repos': { status } });
    const result = await userRepoCreator(http)('t', { name: 'r', description: '', private: false });
    assert.equal(result.kind, kind, `HTTP ${status} must mean ${kind}`);
  }
});

// Die Vorschlagsliste im Dialog „Neues Log": nur Repos, die die App auf dem
// EIGENEN Konto sehen darf. /user/installations mit einem Nutzer-Token
// liefert ausschließlich Installationen dieser App, auf die der Mensch
// Zugriff hat -- fremde Organisationen fallen über account.login heraus.
test('userInstalledRepos lists the repositories of the installation on the own account, across pages', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `repo-${i}`, private: i % 2 === 0, owner: { login: 'octocat' } }));
  const http = fakeHttp({
    'GET /user/installations?per_page=100': { body: { installations: [
      { id: 7, account: { login: 'some-org' } },
      { id: 9, account: { login: 'octocat' } },
    ] } },
    'GET /user/installations/9/repositories?per_page=100&page=1': { body: { repositories: page1 } },
    'GET /user/installations/9/repositories?per_page=100&page=2': { body: { repositories: [{ name: 'last', private: false, owner: { login: 'octocat' } }] } },
  });
  const result = await userInstalledRepos(http)('gho_user', 'octocat');
  assert.equal(result.kind, 'ok');
  const repos = result.kind === 'ok' ? result.repos : [];
  assert.equal(repos.length, 101, 'the second page is read too');
  assert.deepEqual(repos[0], { name: 'repo-0', private: true });
  assert.deepEqual(repos[100], { name: 'last', private: false });
  assert.equal(http.calls.some((c) => c.includes('/installations/7/')), false, 'another account\'s installation is never read');
});

test('userInstalledRepos answers an empty list when the app is not installed on the own account', async () => {
  const http = fakeHttp({
    'GET /user/installations?per_page=100': { body: { installations: [{ id: 7, account: { login: 'some-org' } }] } },
  });
  assert.deepEqual(await userInstalledRepos(http)('t', 'octocat'), { kind: 'ok', repos: [] });
});

test('userInstalledRepos maps 401 to unauthorized and a 5xx to unavailable', async () => {
  const dead = fakeHttp({ 'GET /user/installations?per_page=100': { status: 401 } });
  assert.deepEqual(await userInstalledRepos(dead)('t', 'octocat'), { kind: 'unauthorized' });
  const down = fakeHttp({
    'GET /user/installations?per_page=100': { body: { installations: [{ id: 9, account: { login: 'octocat' } }] } },
    'GET /user/installations/9/repositories?per_page=100&page=1': { status: 502 },
  });
  assert.deepEqual(await userInstalledRepos(down)('t', 'octocat'), { kind: 'unavailable', status: 502 });
});
