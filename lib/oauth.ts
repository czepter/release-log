// Der gesamte Autorisierungsserver (spec §5, "Rolle 2"): Registrierung,
// Zustimmung, Token-Ausgabe/-Rotation/-Widerruf. Die MCP-SDK deckt nur die
// Resource-Server-Seite ab (Bearer-Prüfung) -- alles hier ist von Hand,
// weil es das sein muss (Abweichung 1).
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { oauthClient } from './db/schema.ts';

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
