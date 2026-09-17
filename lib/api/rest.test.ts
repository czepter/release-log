import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCtx, signIn, addLog } from '../fixtures.ts';
import type { Ctx } from '../fixtures.ts';
import { release, allowlist } from '../db/schema.ts';
import { registerClient, mintTokenPair } from '../oauth.ts';
import { getRelease, putRelease, publishRelease } from './releases.ts';
import { session, listClients, revokeClient, listAllowlist, upsertAllowlist, deleteAllowlist } from './account.ts';
import { publicLog, publicRelease, viewerFor } from './public.ts';
import { consent } from './consent.ts';

const core = (ctx: Ctx) => ({ auth: ctx.auth, reader: ctx.reader });
const body = (reply: { body: unknown }) => reply.body as Record<string, any>;

const DOC = {
  version: '1.0.0', date: '2026-09-01', headline: 'Erste Version', body: ['Absatz'],
  changes: [{ type: 'feat', title: 'Suche', description: 'x', commit: 'a', date: '2026-09-01' }],
};

function addRelease(ctx: Ctx, logId: string, version: string, publishedAt: string | null): void {
  ctx.db.insert(release).values({
    logId, version, date: '2026-09-01', publishedAt, blobSha: `sha-${version}`, path: `releases/${version}.json`,
    doc: JSON.stringify({ ...DOC, version, published_at: publishedAt, tag: null, commits: 0, image: null, covered: ['c1'] }),
  }).run();
}

test('getRelease returns the whole document with its blob sha, and 404 for an unknown version', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    addRelease(ctx, 'mine', '1.0.0', null);
    const reply = await getRelease(core(ctx), who, 'mine', '1.0.0');
    assert.equal(body(reply).blob_sha, 'sha-1.0.0');
    assert.deepEqual(body(reply).document.covered, ['c1']);
    assert.equal((await getRelease(core(ctx), who, 'mine', '9.9.9')).status, 404);
  });
});

// Fällt, wenn der Konfliktstand nicht beim Editor ankommt.
test('putRelease maps a conflict to 409 carrying the current document', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    addRelease(ctx, 'mine', '1.0.0', null);
    const reply = await putRelease(core(ctx), who, 'mine', '1.0.0', { document: DOC });
    assert.equal(reply.status, 409);
    assert.equal(body(reply).current.blob_sha, 'sha-1.0.0');
    assert.equal(ctx.puts.length, 0);
  });
});

test('putRelease: invalid document 400 with parser text, success 200 with permalink', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    const bad = await putRelease(core(ctx), who, 'mine', '2.0.0', { document: { version: '2.0.0' } });
    assert.equal(bad.status, 400);
    assert.match(body(bad).message, /headline/);
    const good = await putRelease(core(ctx), who, 'mine', '1.0.0', { document: DOC, base_blob_sha: null });
    assert.equal(good.status, 200);
    assert.equal(body(good).permalink, 'https://example.test/l/mine/r/1.0.0');
  });
});

test('publishRelease sets and clears published_at; frozen is 409', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    addLog(ctx, 'gone', { state: 'frozen' });
    ctx.permission.mine = 'write';
    addRelease(ctx, 'mine', '1.0.0', null);
    assert.equal((await publishRelease(core(ctx), who, 'mine', '1.0.0', true)).status, 200);
    assert.match(JSON.parse(ctx.puts[0].content.toString('utf8')).published_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await publishRelease(core(ctx), who, 'mine', '1.0.0', false)).status, 200);
    assert.equal(JSON.parse(ctx.puts[1].content.toString('utf8')).published_at, null);
    assert.equal((await publishRelease(core(ctx), who, 'gone', '1.0.0', true)).status, 409);
  });
});

test('session reports login, admin flag and avatar', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'admin');
    assert.deepEqual(body(session(core(ctx), who)), { login: 'admin', isAdmin: true, avatarUrl: null, lastSeenAt: '2026-09-01T00:00:00.000Z' });
  });
});

test('clients: list shows a connected client, revoke removes only the own connection', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    const { who: other } = signIn(ctx, 'other');
    const reg = registerClient(ctx.db, { client_name: 'Claude', redirect_uris: ['https://c.test/cb'] });
    if (!reg.ok) throw new Error('register');
    mintTokenPair(ctx.db, { clientId: reg.value.clientId, accountId: who.accountId, scope: 'logs:read', familyId: 'f1' });
    mintTokenPair(ctx.db, { clientId: reg.value.clientId, accountId: other.accountId, scope: 'logs:read', familyId: 'f2' });
    assert.deepEqual(body(listClients(core(ctx), who)).clients, [{ clientId: reg.value.clientId, clientName: 'Claude', scope: 'logs:read' }]);
    revokeClient(core(ctx), who, reg.value.clientId);
    assert.deepEqual(body(listClients(core(ctx), who)).clients, []);
    assert.equal(body(listClients(core(ctx), other)).clients.length, 1);
  });
});

// Fällt, wenn isAdmin nicht geprüft wird.
test('allowlist is admin-only for reading, adding and removing', async () => {
  await withCtx(async (ctx) => {
    const { who: dev } = signIn(ctx, 'dev');
    assert.equal(listAllowlist(core(ctx), dev).status, 403);
    assert.equal(upsertAllowlist(core(ctx), dev, { github_login: 'x' }).status, 403);
    assert.equal(deleteAllowlist(core(ctx), dev, 'x').status, 403);
    assert.equal(ctx.db.select().from(allowlist).all().length, 0);
  });
});

test('allowlist: add records who added it, re-adding updates the note, delete removes exactly that login', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'admin');
    assert.equal(upsertAllowlist(core(ctx), who, { github_login: '' }).status, 400);
    upsertAllowlist(core(ctx), who, { github_login: 'alice', note: 'Team A' });
    upsertAllowlist(core(ctx), who, { github_login: 'bob', note: '' });
    upsertAllowlist(core(ctx), who, { github_login: 'alice', note: 'Team B' });
    const entries = body(listAllowlist(core(ctx), who)).entries as Array<{ githubLogin: string; note: string | null; addedBy: string }>;
    assert.deepEqual(entries.map((e) => [e.githubLogin, e.note, e.addedBy]).sort(), [['alice', 'Team B', 'admin'], ['bob', null, 'admin']]);
    deleteAllowlist(core(ctx), who, 'alice');
    assert.deepEqual(ctx.db.select().from(allowlist).all().map((e) => e.githubLogin), ['bob']);
  });
});

function addIndexedLog(ctx: Ctx, id: string, visibility: 'public' | 'private'): void {
  addLog(ctx, id, { visibility });
}

// Fällt, wenn die Sichtbarkeit nicht geprüft wird -- dann verriete die
// Seite die Existenz eines privaten Logs.
test('publicLog: a private log is 404 to the public, exactly like a missing one', async () => {
  await withCtx(async (ctx) => {
    addIndexedLog(ctx, 'priv', 'private');
    assert.deepEqual(publicLog(core(ctx), 'public', 'priv'), publicLog(core(ctx), 'public', 'nope'));
    assert.equal(publicLog(core(ctx), 'public', 'nope').status, 404);
    assert.equal(publicLog(core(ctx), 'member', 'priv').status, 200);
  });
});

test('publicLog and publicRelease hide drafts from the public and show them to members, without covered', async () => {
  await withCtx(async (ctx) => {
    addIndexedLog(ctx, 'pub', 'public');
    addRelease(ctx, 'pub', '1.0.0', '2026-09-01T00:00:00Z');
    addRelease(ctx, 'pub', '1.1.0', null);
    assert.deepEqual(body(publicLog(core(ctx), 'public', 'pub')).releases.map((r: { version: string }) => r.version), ['1.0.0']);
    assert.equal(publicRelease(core(ctx), 'public', 'pub', '1.1.0').status, 404);
    const member = body(publicRelease(core(ctx), 'member', 'pub', '1.1.0'));
    assert.equal(member.release.version, '1.1.0');
    assert.equal('covered' in member.release, false);
    assert.equal(member.release.sections[0].label, 'Neu');
    assert.equal(member.log.visibility, 'public');
  });
});

test('viewerFor: member only with write access to that log', async () => {
  await withCtx(async (ctx) => {
    addIndexedLog(ctx, 'pub', 'public');
    const { who } = signIn(ctx, 'dev');
    assert.equal(await viewerFor(core(ctx), null, 'pub'), 'public');
    ctx.permission.pub = 'read';
    assert.equal(await viewerFor(core(ctx), who, 'pub'), 'public');
    addIndexedLog(ctx, 'pub2', 'public');
    ctx.permission.pub2 = 'write';
    assert.equal(await viewerFor(core(ctx), who, 'pub2'), 'member');
  });
});

test('consent lists writable logs and round-trips the form fields', async () => {
  await withCtx(async (ctx) => {
    const reg = registerClient(ctx.db, { client_name: 'Claude', redirect_uris: ['https://c.test/cb'] });
    if (!reg.ok) throw new Error('register');
    addLog(ctx, 'mine');
    addLog(ctx, 'theirs');
    ctx.permission.mine = 'write';
    const { who } = signIn(ctx, 'dev');
    const search = new URLSearchParams({
      client_id: reg.value.clientId, redirect_uri: 'https://c.test/cb', response_type: 'code', state: 'st',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'logs:write',
    }).toString();
    const b = body(await consent(core(ctx), who, search));
    assert.equal(b.kind, 'ok');
    assert.equal(b.clientName, 'Claude');
    assert.deepEqual(b.logs, [{ product: 'Produkt mine', repo: 'o/mine' }]);
    assert.deepEqual(b.form, { client_id: reg.value.clientId, redirect_uri: 'https://c.test/cb', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 'st', scope: 'logs:write' });
    assert.equal(body(await consent(core(ctx), null, search)).kind, 'login');
  });
});
