import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCtx, signIn, addLog } from './fixtures.ts';
import { accountFromCookie, logAccess } from './access.ts';

test('accountFromCookie resolves a signed session and marks admins', async () => {
  await withCtx(async (ctx) => {
    const { cookie } = signIn(ctx, 'admin');
    assert.deepEqual(
      { ...accountFromCookie(ctx.auth, `other=1; ${cookie}`), accountId: 0 },
      { accountId: 0, login: 'admin', isAdmin: true },
    );
    assert.equal(accountFromCookie(ctx.auth, `${cookie}x`), null);
    assert.equal(accountFromCookie(ctx.auth, undefined), null);
  });
});

test('logAccess: missing is 404, no write access is 403, write access is ok', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'dev');
    addLog(ctx, 'mine');
    addLog(ctx, 'theirs');
    ctx.permission.mine = 'write';
    ctx.permission.theirs = 'read';
    assert.deepEqual(await logAccess(ctx.auth, who, 'nope', { frozenAdmin: false }), { ok: false, status: 404 });
    assert.deepEqual(await logAccess(ctx.auth, who, 'theirs', { frozenAdmin: false }), { ok: false, status: 403 });
    assert.equal((await logAccess(ctx.auth, who, 'mine', { frozenAdmin: false })).ok, true);
  });
});

// Fällt, wenn die Admin-Ausnahme ohne das Flag greift -- dann könnte ein
// Admin in ein unerreichbares Repo zu schreiben versuchen.
test('logAccess: a frozen log is reachable for an admin only with frozenAdmin', async () => {
  await withCtx(async (ctx) => {
    const { who } = signIn(ctx, 'admin');
    addLog(ctx, 'gone', { state: 'frozen' });
    assert.equal((await logAccess(ctx.auth, who, 'gone', { frozenAdmin: true })).ok, true);
    assert.deepEqual(await logAccess(ctx.auth, who, 'gone', { frozenAdmin: false }), { ok: false, status: 403 });
    const { who: dev } = signIn(ctx, 'dev');
    assert.deepEqual(await logAccess(ctx.auth, dev, 'gone', { frozenAdmin: true }), { ok: false, status: 403 });
  });
});
