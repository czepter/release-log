// Wer angemeldet ist, und wer sich überhaupt anmelden darf. Beides sitzt
// hier zusammen, weil eine Session ohne Zulassungsprüfung sinnlos wäre —
// spec §9 nennt genau diese Kombination als eine Datei ("Cookie-Session,
// Zulassungsprüfung").

import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { allowlist } from './db/schema.ts';

export type SessionPayload = { accountId: number };

// 30 Tage, wörtlich aus Spec §5. Exported so server.ts's Set-Cookie header
// interpolates this value instead of carrying its own copy of the literal —
// two copies of "2592000" can drift, one export cannot.
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function sign(signingKey: string, data: string): string {
  return createHmac('sha256', signingKey).update(data).digest('base64url');
}

export function createSessionCookie(
  signingKey: string,
  accountId: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = JSON.stringify({ accountId, exp: nowSeconds + SESSION_MAX_AGE_SECONDS });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${sign(signingKey, encoded)}`;
}

export function verifySessionCookie(
  signingKey: string,
  cookie: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (typeof cookie !== 'string' || cookie === '') return null;
  const dot = cookie.indexOf('.');
  if (dot === -1) return null;
  const encoded = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  if (encoded === '' || signature === '') return null;

  const expected = Buffer.from(sign(signingKey, encoded), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  // Length first: timingSafeEqual throws on a mismatch, and the length of
  // a signature is public anyway — comparing it leaks nothing an attacker
  // could not compute themselves.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: { accountId?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  if (typeof payload.accountId !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= nowSeconds) return null;
  return { accountId: payload.accountId };
}

// Adminrecht ist ausschließlich Zulassung, keine Datenbankspalte (spec §5,
// Global Constraints): jemanden zum Admin zu machen heißt, ADMIN_LOGINS zu
// ändern, nicht eine Zeile zu schreiben.
export function isAdmin(login: string, adminLogins: string[]): boolean {
  return adminLogins.includes(login);
}

export function isAllowed(db: Db, login: string, adminLogins: string[]): boolean {
  // ADMIN_LOGINS zuerst und ohne Datenbankzugriff: es existiert genau
  // dafür, das System erreichbar zu halten, wenn die Tabelle leer ist
  // (spec §5, Henne-Ei-Problem) — ein Tabellen-Miss könnte diese Antwort
  // nie in ein Nein verwandeln.
  if (isAdmin(login, adminLogins)) return true;
  return db.select().from(allowlist).where(eq(allowlist.githubLogin, login)).all().length > 0;
}
