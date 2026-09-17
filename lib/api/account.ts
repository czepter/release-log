import { eq } from 'drizzle-orm';
import { account, allowlist } from '../db/schema.ts';
import { listConnectedClients, revokeAllForClient } from '../oauth.ts';
import type { LoggedIn } from '../access.ts';
import type { Core, Reply } from './core.ts';
import { ok, fail, text } from './core.ts';

export function session({ auth }: Core, who: LoggedIn): Reply {
  const row = auth.db.select().from(account).where(eq(account.githubUserId, who.accountId)).all()[0];
  return ok({ login: who.login, isAdmin: who.isAdmin, avatarUrl: row?.avatarUrl ?? null, lastSeenAt: row?.lastSeenAt ?? null });
}

export function listClients({ auth }: Core, who: LoggedIn): Reply {
  return ok({ clients: listConnectedClients(auth.db, who.accountId) });
}

// Nur die eigenen Token: revokeAllForClient ist auf accountId beschränkt,
// ein fremder clientId trennt hier also nie die Verbindung eines anderen.
export function revokeClient({ auth }: Core, who: LoggedIn, clientId: string): Reply {
  revokeAllForClient(auth.db, who.accountId, clientId, new Date().toISOString());
  return ok({ revoked: true });
}

const ADMIN_ONLY = fail(403, 'forbidden', 'Nur Admins verwalten die Zulassungsliste.');

export function listAllowlist({ auth }: Core, who: LoggedIn): Reply {
  if (!who.isAdmin) return ADMIN_ONLY;
  return ok({ entries: auth.db.select().from(allowlist).all() });
}

export function upsertAllowlist({ auth }: Core, who: LoggedIn, input: unknown): Reply {
  if (!who.isAdmin) return ADMIN_ONLY;
  const login = (text(input, 'github_login') ?? '').trim();
  if (!login) return fail(400, 'missing_login', 'Ein GitHub-Login ist erforderlich.');
  const rawNote = (text(input, 'note') ?? '').trim();
  const note = rawNote === '' ? null : rawNote;
  const addedAt = new Date().toISOString();
  auth.db.insert(allowlist)
    .values({ githubLogin: login, addedBy: who.login, addedAt, note })
    .onConflictDoUpdate({ target: allowlist.githubLogin, set: { addedBy: who.login, addedAt, note } })
    .run();
  return ok({ githubLogin: login }, 201);
}

export function deleteAllowlist({ auth }: Core, who: LoggedIn, login: string): Reply {
  if (!who.isAdmin) return ADMIN_ONLY;
  auth.db.delete(allowlist).where(eq(allowlist.githubLogin, login)).run();
  return ok({ deleted: true });
}
