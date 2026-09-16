import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { withCtx, signIn, addLog } from '../fixtures.ts';
import type { Ctx } from '../fixtures.ts';
import { log, release, media, syncError, repoPermission } from '../db/schema.ts';
import { listLogs, createLogApi, logDetail, updateSettings, uploadMedia, deleteLog } from './logs.ts';

const core = (ctx: Ctx) => ({ auth: ctx.auth, reader: ctx.reader });
const body = (reply: { body: unknown }) => reply.body as Record<string, any>;

function addRelease(ctx: Ctx, logId: string, version: string, date: string, publishedAt: string | null): void {
  ctx.db.insert(release).values({
    logId, version, date, publishedAt, blobSha: `sha-${version}`, path: `releases/${version}.json`,
    doc: JSON.stringify({ version, date, headline: `Headline ${version}`, published_at: publishedAt, body: [], changes: [], covered: [], image: null, tag: null, commits: 0 }),
  }).run();
}

// Fällt, wenn die Liste die Rechteprüfung auslässt.
test('listLogs shows only logs the account can write to', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    addLog(ctx, 'theirs');
    ctx.permission.mine = 'write';
    ctx.permission.theirs = 'read';
    const reply = await listLogs(core(ctx), who);
    assert.deepEqual(body(reply).logs.map((l: { id: string }) => l.id), ['mine']);
  });
});

// Fällt, wenn adminSeesFrozen fehlt oder GitHub trotzdem gefragt wird.
test('listLogs shows a frozen log to an admin without asking GitHub, and hides it from others', async () => {
  await withCtx(async (ctx) => {
    addLog(ctx, 'gone', { state: 'frozen' });
    let asked = 0;
    const original = ctx.auth.gh.collaboratorPermission;
    ctx.auth.gh.collaboratorPermission = async (ref, login) => { asked++; return original(ref, login); };
    const { who: admin } = signIn(ctx, 'admin');
    assert.deepEqual(body(await listLogs(core(ctx), admin)).logs.map((l: { id: string }) => l.id), ['gone']);
    assert.equal(asked, 0);
    const { who: dev } = signIn(ctx, 'dev');
    assert.deepEqual(body(await listLogs(core(ctx), dev)).logs, []);
  });
});

test('createLogApi without a stored user token asks for a fresh login with 401', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    const reply = await createLogApi(core(ctx), who, { product: 'Neu', repo_name: 'neu' });
    assert.equal(reply.status, 401);
    assert.equal(body(reply).error, 'reauth_required');
  });
});

test('logDetail: 404 for unknown, 403 without write access', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'theirs');
    assert.equal((await logDetail(core(ctx), who, 'nope')).status, 404);
    assert.equal((await logDetail(core(ctx), who, 'theirs')).status, 403);
  });
});

test('logDetail carries releases newest first with draft state, sync errors, media and the installation state', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine', { curationNotes: 'kurz' });
    ctx.permission.mine = 'write';
    addRelease(ctx, 'mine', '1.0.0', '2026-09-01', '2026-09-01T00:00:00Z');
    addRelease(ctx, 'mine', '1.1.0', '2026-09-10', null);
    ctx.db.insert(syncError).values({ logId: 'mine', path: 'releases/x.json', message: 'kaputt', at: '2026-09-10T00:00:00Z' }).run();
    ctx.db.insert(media).values({ logId: 'mine', path: 'media/a.png', blobSha: 'm', contentType: 'image/png', bytes: Buffer.from([1]) }).run();
    ctx.auth.gh.probe = async () => ({ kind: 'no_installation' });
    const reply = await logDetail(core(ctx), who, 'mine');
    assert.equal(reply.status, 200);
    const b = body(reply);
    assert.deepEqual(b.releases.map((r: { version: string; published_at: string | null }) => [r.version, r.published_at]), [['1.1.0', null], ['1.0.0', '2026-09-01T00:00:00Z']]);
    assert.equal(b.releases[0].headline, 'Headline 1.1.0');
    assert.deepEqual(b.errors, [{ path: 'releases/x.json', message: 'kaputt' }]);
    assert.deepEqual(b.media, ['media/a.png']);
    assert.equal(b.installation, 'no_installation');
    assert.equal(b.configBlobSha, 'cfgsha');
    assert.equal(b.curationNotes, 'kurz');
  });
});

// Fällt, wenn Einstellungen in die Datenbank statt ins Repo gehen, oder
// wenn ein leerer Hinweis als "" committet wird.
test('updateSettings commits release-log.json against expected_sha and leaves the index alone', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    const reply = await updateSettings(core(ctx), who, 'mine', { view: 'timeline', visibility: 'private', curation_notes: '', expected_sha: 'cfgsha', id: 'forged', product: 'forged' });
    assert.equal(reply.status, 200);
    assert.equal(ctx.puts.length, 1);
    assert.equal(ctx.puts[0].path, 'release-log.json');
    assert.equal(ctx.puts[0].expectedSha, 'cfgsha');
    assert.deepEqual(JSON.parse(ctx.puts[0].content.toString('utf8')), { id: 'mine', product: 'Produkt mine', view: 'timeline', visibility: 'private', curation_notes: null });
    assert.equal(ctx.db.select().from(log).where(eq(log.publicId, 'mine')).all()[0].view, 'full');
    assert.equal(ctx.repoWrites.length, 1);
  });
});

test('updateSettings: invalid view 400, conflict 409, no_installation 502 -- none of them enqueue a resync', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    assert.equal((await updateSettings(core(ctx), who, 'mine', { view: 'grid', visibility: 'public' })).status, 400);
    assert.equal(ctx.puts.length, 0);
    ctx.commit = { kind: 'conflict' };
    assert.equal((await updateSettings(core(ctx), who, 'mine', { view: 'full', visibility: 'public', expected_sha: 'stale' })).status, 409);
    ctx.commit = { kind: 'no_installation' };
    assert.equal((await updateSettings(core(ctx), who, 'mine', { view: 'full', visibility: 'public' })).status, 502);
    assert.equal(ctx.repoWrites.length, 0);
  });
});

test('updateSettings: without write access 403, on a frozen log 409 even for an admin, nothing committed', async () => {
  await withCtx(async (ctx) => {
    addLog(ctx, 'theirs');
    addLog(ctx, 'gone', { state: 'frozen' });
    const { who: dev } = signIn(ctx, 'dev');
    const { who: admin } = signIn(ctx, 'admin');
    assert.equal((await updateSettings(core(ctx), dev, 'theirs', { view: 'full', visibility: 'public' })).status, 403);
    assert.equal((await updateSettings(core(ctx), admin, 'gone', { view: 'full', visibility: 'public' })).status, 409);
    assert.equal(ctx.puts.length, 0);
  });
});

// Fällt, wenn die Pfadprüfung fehlt: dann schriebe ein Upload außerhalb von media/.
test('uploadMedia refuses anything but a bare, supported, non-empty file name', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    const png = Buffer.from([1, 2, 3]);
    assert.equal(body(await uploadMedia(core(ctx), who, 'mine', encodeURIComponent('../x.png'), png)).error, 'bad_filename');
    assert.equal(body(await uploadMedia(core(ctx), who, 'mine', undefined, png)).error, 'bad_filename');
    assert.equal(body(await uploadMedia(core(ctx), who, 'mine', '%zz.png', png)).error, 'bad_filename');
    assert.equal((await uploadMedia(core(ctx), who, 'mine', 'a.gif', png)).status, 415);
    assert.equal(body(await uploadMedia(core(ctx), who, 'mine', 'a.png', Buffer.alloc(0))).error, 'empty_body');
    assert.equal(ctx.puts.length, 0);
  });
});

test('uploadMedia commits a new file under media/ with the name byte for byte and triggers a resync', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    const reply = await uploadMedia(core(ctx), who, 'mine', encodeURIComponent('Bild 1.PNG'), Buffer.from([9]));
    assert.deepEqual(reply, { status: 200, body: { path: 'media/Bild 1.PNG' } });
    assert.equal(ctx.puts[0].path, 'media/Bild 1.PNG');
    assert.equal(ctx.puts[0].expectedSha, null);
    assert.equal(ctx.repoWrites.length, 1);
    ctx.commit = { kind: 'conflict' };
    assert.equal(body(await uploadMedia(core(ctx), who, 'mine', 'b.png', Buffer.from([9]))).error, 'path_exists');
    assert.equal(ctx.repoWrites.length, 1);
  });
});

// Fällt, wenn der Namensvergleich fehlt.
test('deleteLog with the wrong name deletes nothing; with the right one wipes every row of the log', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    ctx.permission.mine = 'write';
    addRelease(ctx, 'mine', '1.0.0', '2026-09-01', null);
    ctx.db.insert(media).values({ logId: 'mine', path: 'media/a.png', blobSha: 'm', contentType: 'image/png', bytes: Buffer.from([1]) }).run();
    ctx.db.insert(syncError).values({ logId: 'mine', path: 'x', message: 'y', at: 'z' }).run();
    assert.equal((await deleteLog(core(ctx), who, 'mine', { confirm_name: 'Produkt falsch' })).status, 400);
    assert.equal(ctx.db.select().from(log).all().length, 1);
    assert.equal((await deleteLog(core(ctx), who, 'mine', { confirm_name: 'Produkt mine' })).status, 200);
    for (const table of [log, release, media, syncError, repoPermission]) assert.equal(ctx.db.select().from(table).all().length, 0);
  });
});

test('deleteLog: an admin may delete a frozen log without write access; a non-admin may not delete a foreign log', async () => {
  await withCtx(async (ctx) => {
    addLog(ctx, 'gone', { state: 'frozen' });
    addLog(ctx, 'theirs');
    const { who: admin } = signIn(ctx, 'admin');
    const { who: dev } = signIn(ctx, 'dev');
    assert.equal((await deleteLog(core(ctx), dev, 'theirs', { confirm_name: 'Produkt theirs' })).status, 403);
    assert.equal((await deleteLog(core(ctx), admin, 'gone', { confirm_name: 'Produkt gone' })).status, 200);
  });
});
