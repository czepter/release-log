import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log, release, account } from './db/schema.ts';
import { indexReader } from './indexReader.ts';
import { fakeGitHub } from './github.ts';
import type { GitHub } from './github.ts';
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
function withServerFor(
  fn: (factory: ReturnType<typeof buildMcpServer>, db: ReturnType<typeof openDb>) => Promise<void>,
  gh: GitHub = fakeGitHub({}),
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-mcptools-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const factory = buildMcpServer(db, indexReader(db), permissions(db, gh));
  return fn(factory, db).finally(() => { rmSync(dir, { recursive: true, force: true }); });
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
