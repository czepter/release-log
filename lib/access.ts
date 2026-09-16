// Wer ist angemeldet, und darf er an dieses Log? Einmal für die Protokoll-
// Routen des Kerns und die Seiten-API (lib/api), damit die Admin-Ausnahme
// für eingefrorene Logs nicht an sieben Stellen einzeln abweicht.

import { eq } from 'drizzle-orm';
import { account, log } from './db/schema.ts';
import type { RepoRef } from './github.ts';
import { verifySessionCookie, isAdmin } from './session.ts';
import type { Auth } from '../server.ts';

export type LoggedIn = { accountId: number; login: string; isAdmin: boolean };

// Node's IncomingMessage never splits the `cookie` header for you, and
// pulling in a dependency for "find one name=value pair" would be the
// opposite of lazy.
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function accountFromCookie(auth: Auth, cookieHeader: string | undefined): LoggedIn | null {
  const session = verifySessionCookie(auth.signingKey, cookieValue(cookieHeader, 'session'));
  if (!session) return null;
  const row = auth.db.select().from(account).where(eq(account.githubUserId, session.accountId)).all()[0];
  return row ? { accountId: session.accountId, login: row.login, isAdmin: isAdmin(row.login, auth.adminLogins) } : null;
}

export type LogRow = typeof log.$inferSelect;
export type LogAccess =
  | { ok: true; row: LogRow; ref: RepoRef }
  | { ok: false; status: 404 | 403 };

// frozenAdmin: GitHub beantwortet jede Rechteanfrage auf ein gelöschtes
// Repo mit 404, also wäre ein eingefrorenes Log für niemanden je
// schreibbar -- und damit auch nicht löschbar, obwohl Löschen genau dafür
// da ist (Plan 6, Abweichung 7). Wer lesen oder löschen will, bekommt die
// Ausnahme; wer ins Repo schreiben will, nicht.
export async function logAccess(auth: Auth, who: LoggedIn, logId: string, opts: { frozenAdmin: boolean }): Promise<LogAccess> {
  const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
  if (!row) return { ok: false, status: 404 };
  const ref = { owner: row.repoOwner, repo: row.repoName };
  if (row.state === 'frozen' && who.isAdmin && opts.frozenAdmin) return { ok: true, row, ref };
  const allowed = await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref);
  return allowed ? { ok: true, row, ref } : { ok: false, status: 403 };
}
