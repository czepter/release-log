// Der gesamte Autorisierungsserver (spec §5, "Rolle 2"): Registrierung,
// Zustimmung, Token-Ausgabe/-Rotation/-Widerruf. Die MCP-SDK deckt nur die
// Resource-Server-Seite ab (Bearer-Prüfung) -- alles hier ist von Hand,
// weil es das sein muss (Abweichung 1).
import { randomBytes, createHash } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { oauthClient, oauthCode, oauthToken, account } from './db/schema.ts';
import { verifyPkce } from './pkce.ts';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

// http ist nur für Loopback erlaubt (native Clients, RFC 8252) -- jeder
// andere Host braucht https. Eine nicht parsbare URL ist ungültig, kein Crash.
function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return true;
  return false;
}

export type RegisterClientInput = { redirect_uris?: unknown; client_name?: unknown };

export type RegisterClientResult =
  | { ok: true; value: { clientId: string; clientName: string; redirectUris: string[] } }
  | { ok: false; errors: string[] };

export function registerClient(db: Db, input: unknown, nowIso: () => string = () => new Date().toISOString()): RegisterClientResult {
  if (typeof input !== 'object' || input === null) return { ok: false, errors: ['request body must be a JSON object'] };
  const { redirect_uris, client_name } = input as RegisterClientInput;

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return { ok: false, errors: ['redirect_uris: required, non-empty array'] };
  }
  if (!redirect_uris.every(isAcceptableRedirectUri)) {
    return { ok: false, errors: ['redirect_uris: each entry must be an https URL, or an http URL on a loopback host'] };
  }
  if (client_name !== undefined && typeof client_name !== 'string') {
    return { ok: false, errors: ['client_name: must be a string'] };
  }

  const clientId = `mcp_${randomToken(16)}`;
  const clientName = client_name === undefined || client_name === '' ? 'Unnamed MCP client' : client_name;
  const redirectUris = redirect_uris as string[];

  db.insert(oauthClient).values({
    clientId, clientName, redirectUris: JSON.stringify(redirectUris), createdAt: nowIso(),
  }).run();

  return { ok: true, value: { clientId, clientName, redirectUris } };
}

export function findClient(db: Db, clientId: string): { clientId: string; clientName: string; redirectUris: string[] } | null {
  const row = db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).all()[0];
  if (!row) return null;
  return { clientId: row.clientId, clientName: row.clientName, redirectUris: JSON.parse(row.redirectUris) };
}

export type MintCodeInput = { clientId: string; redirectUri: string; codeChallenge: string; accountId: number; scope: string };

export function mintAuthorizationCode(
  db: Db, input: MintCodeInput, nowIso: () => string = () => new Date().toISOString(),
): string {
  const code = randomToken();
  const familyId = randomToken(16);
  const expiresAt = new Date(Date.parse(nowIso()) + 60_000).toISOString();
  db.insert(oauthCode).values({
    codeHash: sha256Hex(code), clientId: input.clientId, redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge, familyId, accountId: input.accountId, scope: input.scope,
    expiresAt, consumedAt: null,
  }).run();
  return code;
}

export type RedeemCodeInput = { code: string; clientId: string; redirectUri: string; codeVerifier: string };
export type RedeemCodeResult =
  | { ok: true; value: { accountId: number; scope: string; familyId: string } }
  | { ok: false; error: 'invalid_grant' };

export function redeemAuthorizationCode(
  db: Db, input: RedeemCodeInput, nowMs: () => number = Date.now,
): RedeemCodeResult {
  const now = nowMs();
  const row = db.select().from(oauthCode).where(eq(oauthCode.codeHash, sha256Hex(input.code))).all()[0];
  if (!row) return { ok: false, error: 'invalid_grant' };

  if (row.consumedAt !== null) {
    // Zweite Einlösung: die ganze Kette widerrufen, die aus diesem Code
    // entstand (spec §5) -- ein Code, der schon einmal eingelöst wurde,
    // gibt beim zweiten Versuch nichts Neues, UND alles, was das erste Mal
    // entstand, wird ungültig. Das ist der einzige Hinweis, den ein
    // gestohlener, mehrfach benutzter Code je gibt.
    revokeFamily(db, row.familyId, new Date(now).toISOString());
    return { ok: false, error: 'invalid_grant' };
  }
  // client_id und redirect_uri müssen exakt zu dem passen, womit der Code
  // ausgestellt wurde (spec §5) -- sonst könnte ein Code, der einem
  // Client zugeteilt wurde, bei einem anderen eingelöst werden.
  if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) {
    return { ok: false, error: 'invalid_grant' };
  }
  if (Date.parse(row.expiresAt) <= now) return { ok: false, error: 'invalid_grant' };
  if (!verifyPkce(input.codeVerifier, row.codeChallenge, 'S256')) return { ok: false, error: 'invalid_grant' };

  db.update(oauthCode).set({ consumedAt: new Date(now).toISOString() }).where(eq(oauthCode.codeHash, row.codeHash)).run();
  return { ok: true, value: { accountId: row.accountId, scope: row.scope, familyId: row.familyId } };
}

export function revokeFamily(db: Db, familyId: string, nowIsoValue: string): void {
  db.update(oauthToken).set({ revokedAt: nowIsoValue })
    .where(and(eq(oauthToken.familyId, familyId), isNull(oauthToken.revokedAt)))
    .run();
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 Stunde (spec §5)
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage (spec §5)

export type MintTokenPairInput = { clientId: string; accountId: number; scope: string; familyId: string };
export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

export function mintTokenPair(
  db: Db, input: MintTokenPairInput, nowIso: () => string = () => new Date().toISOString(),
): TokenPair {
  const now = Date.parse(nowIso());
  const accessToken = randomToken();
  const refreshToken = randomToken();
  db.insert(oauthToken).values({
    id: randomToken(8), familyId: input.familyId, clientId: input.clientId, accountId: input.accountId,
    scope: input.scope, kind: 'access', tokenHash: sha256Hex(accessToken),
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(), revokedAt: null, createdAt: nowIso(),
  }).run();
  db.insert(oauthToken).values({
    id: randomToken(8), familyId: input.familyId, clientId: input.clientId, accountId: input.accountId,
    scope: input.scope, kind: 'refresh', tokenHash: sha256Hex(refreshToken),
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(), revokedAt: null, createdAt: nowIso(),
  }).run();
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}

export type LookedUpToken = { accountId: number; login: string; clientId: string; scope: string; expiresAt: number };

export function lookupAccessToken(db: Db, rawToken: string, nowMs: () => number = Date.now): LookedUpToken | null {
  const row = db.select().from(oauthToken).where(eq(oauthToken.tokenHash, sha256Hex(rawToken))).all()[0];
  if (!row || row.kind !== 'access' || row.revokedAt !== null) return null;
  if (Date.parse(row.expiresAt) <= nowMs()) return null;
  const acct = db.select().from(account).where(eq(account.githubUserId, row.accountId)).all()[0];
  if (!acct) return null;
  return {
    accountId: row.accountId, login: acct.login, clientId: row.clientId, scope: row.scope,
    expiresAt: Math.floor(Date.parse(row.expiresAt) / 1000),
  };
}

export type RotateResult =
  | { ok: true; value: TokenPair & { scope: string; accountId: number } }
  | { ok: false; error: 'invalid_grant' };

export function rotateRefreshToken(db: Db, rawRefreshToken: string, nowMs: () => number = Date.now): RotateResult {
  const now = nowMs();
  const row = db.select().from(oauthToken).where(eq(oauthToken.tokenHash, sha256Hex(rawRefreshToken))).all()[0];
  if (!row || row.kind !== 'refresh') return { ok: false, error: 'invalid_grant' };

  if (row.revokedAt !== null) {
    // Ein bereits rotiertes Refresh-Token taucht wieder auf -- genau die
    // Wiederverwendung, vor der spec §5 warnt. Die ganze Kette wird
    // widerrufen, nicht nur dieser eine Versuch abgelehnt.
    revokeFamily(db, row.familyId, new Date(now).toISOString());
    return { ok: false, error: 'invalid_grant' };
  }
  if (Date.parse(row.expiresAt) <= now) return { ok: false, error: 'invalid_grant' };

  db.update(oauthToken).set({ revokedAt: new Date(now).toISOString() }).where(eq(oauthToken.id, row.id)).run();
  const pair = mintTokenPair(
    db, { clientId: row.clientId, accountId: row.accountId, scope: row.scope, familyId: row.familyId },
    () => new Date(now).toISOString(),
  );
  return { ok: true, value: { ...pair, scope: row.scope, accountId: row.accountId } };
}

// Scoped by accountId AND clientId -- a user revoking "their" connection to a
// client must never revoke a different user's connection to the same client.
export function revokeAllForClient(db: Db, accountId: number, clientId: string, nowIsoValue: string): void {
  db.update(oauthToken).set({ revokedAt: nowIsoValue })
    .where(and(eq(oauthToken.accountId, accountId), eq(oauthToken.clientId, clientId), isNull(oauthToken.revokedAt)))
    .run();
}

export function listConnectedClients(
  db: Db, accountId: number, nowMs: () => number = Date.now,
): Array<{ clientId: string; clientName: string; scope: string }> {
  const now = nowMs();
  const rows = db.select().from(oauthToken)
    .where(and(eq(oauthToken.accountId, accountId), eq(oauthToken.kind, 'refresh'), isNull(oauthToken.revokedAt)))
    .all()
    .filter((row) => Date.parse(row.expiresAt) > now);
  const seen = new Map<string, string>();
  for (const row of rows) if (!seen.has(row.clientId)) seen.set(row.clientId, row.scope);
  return [...seen].map(([clientId, scope]) => {
    const client = findClient(db, clientId);
    return { clientId, clientName: client?.clientName ?? clientId, scope };
  });
}
