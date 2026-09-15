import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log, release, account } from './db/schema.ts';
import { indexReader } from './indexReader.ts';
import { fakeGitHub } from './github.ts';
import type { GitHub, RepoRef } from './github.ts';
import { permissions } from './permissions.ts';
import { mintTokenPair } from './oauth.ts';
import { buildMcpServer } from './mcpTools.ts';

// fakeGitHub({}) always answers collaboratorPermission with null (no repo
// known to it at all) -- it also never looks at the login it's given, so
// there is no fixture syntax that grants write access to one login and not
// another. withServerFor therefore takes the GitHub implementation as an
// optional parameter: the one test below that needs write access supplies a
// hand-built GitHub object literal, the same pattern server.test.ts already
// uses everywhere it needs a specific collaboratorPermission answer.
function withServerFor(fn: (factory: ReturnType<typeof buildMcpServer>, db: ReturnType<typeof openDb>, deps: { onRepoWriteCalls: RepoRef[] }) => Promise<void>, gh?: GitHub): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-mcptools-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const resolvedGh = gh ?? fakeGitHub({});
  const onRepoWriteCalls: RepoRef[] = [];
  const factory = buildMcpServer({
    db, reader: indexReader(db), perms: permissions(db, resolvedGh), gh: resolvedGh,
    onRepoWrite: (ref) => { onRepoWriteCalls.push(ref); }, baseUrl: 'https://example.test',
  });
  return fn(factory, db, { onRepoWriteCalls }).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

// Ruft ein Werkzeug auf, ohne HTTP: dieselbe In-Memory-Verdrahtung, die die
// SDK selbst für ihre eigenen Server-Tests benutzt (InMemoryTransport, ein
// verbundenes Paar, ein von Hand geführter initialize/tools-call-Austausch).
// Das prüft die Werkzeuglogik dieser Datei, nicht die HTTP-Verdrahtung aus
// Task 12 (die hat ihre eigenen Tests in server.test.ts).
//
// Der Plan sah `@modelcontextprotocol/core-internal` als Fundstelle für
// InMemoryTransport & Co vor -- dieses Paket existiert im installierten
// node_modules-Baum nicht (nur core, node, server unter @modelcontextprotocol).
// Alle vier Namen (InMemoryTransport, isJSONRPCResultResponse,
// LATEST_PROTOCOL_VERSION, die JSONRPC*-Typen) sind aber öffentlich aus
// @modelcontextprotocol/server exportiert (geprüft gegen dessen dist/*.d.mts) --
// von dort importiert dieser Test sie stattdessen.
import {
  InMemoryTransport, isJSONRPCResultResponse, LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/server';
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/server';

async function callTool(
  factory: ReturnType<typeof buildMcpServer>,
  authInfo: { token: string; clientId: string; scopes: string[] },
  name: string,
  args: unknown,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = await factory({ era: 'modern', authInfo });
  const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();
  const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
  peerTx.onmessage = (message) => {
    const id = (message as { id?: string | number }).id;
    const waiter = id === undefined ? undefined : waiters.get(id);
    if (id !== undefined && waiter) {
      waiters.delete(id);
      waiter(message);
    }
  };
  await server.connect(serverTx);
  await peerTx.start();
  const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
    new Promise((resolve) => {
      waiters.set(message.id, resolve);
      void peerTx.send(message);
    });
  const notify = (message: JSONRPCNotification): Promise<void> => peerTx.send(message);

  await request({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const response = await request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  await server.close();
  if (isJSONRPCResultResponse(response)) {
    return response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  }
  throw new Error(`tool call failed: ${JSON.stringify(response)}`);
}

test('list_logs lists a public log without any write access', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'list_logs', {});
    const text = JSON.parse(result.content[0].text);
    assert.equal(text.logs.length, 1);
    assert.equal(text.logs[0].id, 'log1');
  });
});

test('list_logs omits a private log the caller cannot write to', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'list_logs', {});
    const text = JSON.parse(result.content[0].text);
    assert.equal(text.logs.length, 0);
  });
});

test('get_log on a private log answers not_found without a logs:read scope holder able to write', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'get_log', { log_id: 'log1' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'not_found');
  });
});

test('get_release hides a draft from a caller without write access, even on a public log', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'r1',
      path: 'releases/1.0.0.json', doc: JSON.stringify({
        version: '1.0.0', tag: null, date: '2026-09-01', published_at: null, commits: 1,
        headline: 'h', body: [], image: null, covered: [], changes: [],
      }),
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'get_release', { log_id: 'log1', version: '1.0.0' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'not_found');
  });
});

test('get_log on a log the caller can write to includes draft versions and covered', async () => {
  // fakeGitHub({}) ignores the login argument entirely and answers null for
  // any repo it doesn't know about, and it never varies its answer by login
  // even for a repo it does know -- so it cannot express "octocat can write,
  // nobody else can". A hand-built GitHub object literal (the pattern already
  // used throughout server.test.ts, e.g. its 'a writable log is listed'
  // test) is the only way to grant write access here.
  const gh: GitHub = {
    probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
    putFile: async () => ({ kind: 'committed', sha: 'x' }),
    collaboratorPermission: async () => 'write',
  };
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'r1',
      path: 'releases/1.0.0.json', doc: JSON.stringify({
        version: '1.0.0', tag: null, date: '2026-09-01', published_at: null, commits: 1,
        headline: 'h', body: [], image: null, covered: ['abc123'], changes: [],
      }),
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:read'] }, 'get_log', { log_id: 'log1' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.versions.length, 1);
    assert.deepEqual(body.covered, ['abc123']);
  }, gh);
});

// Review finding [Important 1]: get_release's own `!reached` gate had zero
// dedicated coverage -- every existing get_release test used a public log,
// so a future edit that let get_release diverge from get_log's reachability
// check (e.g. fetching the release row before checking reach()) could leak a
// whole release document from a private log and nothing here would notice.
// Published on purpose: this isolates the reachability gate from the
// separate draft-hiding check ("hides a draft" above already covers that).
test('get_release on a private log answers not_found without write access, even for a published release', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: '2026-09-02T00:00:00.000Z', blobSha: 'r1',
      path: 'releases/1.0.0.json', doc: JSON.stringify({
        version: '1.0.0', tag: null, date: '2026-09-01', published_at: '2026-09-02T00:00:00.000Z', commits: 1,
        headline: 'TOP SECRET RELEASE NOTES', body: [], image: null, covered: [], changes: [],
      }),
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'get_release', { log_id: 'log1', version: '1.0.0' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'not_found');
  });
});

// Review finding [Important 2]: get_log's draft-filtering was only tested
// for a caller who CAN write (drafts included) -- the inverse, a non-writer
// who must NOT see drafts, had no test. A draft dated newer than the
// published release means a broken filter would surface it as both an
// extra entry in `versions` and (wrongly) the source of `covered`.
test('get_log omits a draft from versions and covered for a caller without write access', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: '2026-09-01T00:00:00.000Z', blobSha: 'r1',
      path: 'releases/1.0.0.json', doc: JSON.stringify({
        version: '1.0.0', tag: null, date: '2026-09-01', published_at: '2026-09-01T00:00:00.000Z', commits: 1,
        headline: 'published', body: [], image: null, covered: ['pub123'], changes: [],
      }),
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '2.0.0', date: '2026-09-10', publishedAt: null, blobSha: 'r2',
      path: 'releases/2.0.0.json', doc: JSON.stringify({
        version: '2.0.0', tag: null, date: '2026-09-10', published_at: null, commits: 1,
        headline: 'draft', body: [], image: null, covered: ['draft456'], changes: [],
      }),
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'get_log', { log_id: 'log1' });
    const body = JSON.parse(result.content[0].text);
    assert.deepEqual(body.versions.map((v: { version: string }) => v.version), ['1.0.0']);
    assert.deepEqual(body.covered, ['pub123']);
  });
});

// Review finding [Important 3]: the `scopes.includes('logs:read')` forbidden
// gate is identical, hand-copied code in all three tools -- untested on any
// of them, so a copy-paste regression (e.g. checking the wrong scope string)
// on any one tool would ship silently.
test('list_logs is forbidden for a token without logs:read scope', async () => {
  await withServerFor(async (factory) => {
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:write'] }, 'list_logs', {});
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  });
});

test('get_log is forbidden for a token without logs:read scope', async () => {
  await withServerFor(async (factory) => {
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:write'] }, 'get_log', { log_id: 'log1' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  });
});

test('get_release is forbidden for a token without logs:read scope', async () => {
  await withServerFor(async (factory) => {
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:write'] }, 'get_release', { log_id: 'log1', version: '1.0.0' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  });
});

const VALID_DOC = {
  version: '1.0.0', date: '2026-09-01', headline: 'Erste Version', body: [],
  changes: [{ type: 'feat', title: 'Suche', description: 'x', commit: 'a', date: '2026-09-01' }],
};

test('write_release creates a brand-new version and returns a commit sha and permalink', async () => {
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.ok(typeof body.commit_sha === 'string');
    assert.equal(body.permalink, 'https://example.test/l/log1/r/1.0.0');
    assert.deepEqual(deps.onRepoWriteCalls, [{ owner: 'o', repo: 'repo1' }]);
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'newsha' }) });
});

test('write_release on an existing version without base_blob_sha answers conflict, without calling putFile', async () => {
  // The fixture records a call and returns a "wrong" success rather than
  // throwing: if the local pre-check regresses, the call reaches putFile,
  // putFileCalled flips true, AND the tool wrongly reports success -- three
  // independent, non-exception-dependent signals catch the same regression,
  // rather than relying on unverified throw-propagation semantics inside
  // the SDK's tool-call dispatch.
  let putFileCalled = false;
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'existing-sha',
      path: 'releases/1.0.0.json', doc: JSON.stringify({ ...VALID_DOC, tag: null, published_at: null, commits: 0, image: null, covered: [] }),
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'conflict');
    assert.equal(putFileCalled, false, 'a known conflict must never reach putFile');
    assert.equal(deps.onRepoWriteCalls.length, 0);
  }, {
    probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write',
    async putFile() { putFileCalled = true; return { kind: 'committed', sha: 'should-not-happen' }; },
  });
});

test('write_release with a stale base_blob_sha maps GitHub\'s own conflict, does not enqueue a resync', async () => {
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'current-sha',
      path: 'releases/1.0.0.json', doc: JSON.stringify({ ...VALID_DOC, tag: null, published_at: null, commits: 0, image: null, covered: [] }),
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC, base_blob_sha: 'a-now-stale-sha',
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'conflict');
    assert.equal(deps.onRepoWriteCalls.length, 0);
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { return { kind: 'conflict' }; } });
});

// Review finding [Important]: the no_installation branch of CommitResult had
// zero test coverage -- only 'conflict' was proven to leave onRepoWriteCalls
// empty. A brand-new version (no local release row) reaches putFile without
// tripping the local pre-check, so this isolates the no_installation mapping
// and its onRepoWrite-scoping from the conflict-branch test above.
test('write_release maps GitHub\'s no_installation to an error, does not enqueue a resync', async () => {
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'no_installation');
    assert.equal(deps.onRepoWriteCalls.length, 0);
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { return { kind: 'no_installation' }; } });
});

test('write_release rejects an invalid document before calling putFile', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: { version: '1.0.0' }, // missing headline, date, ...
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'invalid_document');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { throw new Error('must not be called'); } });
});

test('write_release without write access answers forbidden', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'read', async putFile() { throw new Error('must not be called'); } });
});

test('write_release on a frozen log answers log_frozen', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'frozen', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'log_frozen');
  }, { probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => null, async putFile() { throw new Error('must not be called'); } });
});

test('write_release without the logs:write scope answers forbidden, even with write access', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:read'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { throw new Error('must not be called'); } });
});
