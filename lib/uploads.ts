// Upload-Erlaubnisse für add_media (spec §6, "Medien-Upload"). Das Werkzeug
// gibt eine URL zurück, der Agent schickt die Bytes per PUT dorthin: so
// berühren Bilddaten den Kontext des Agenten nie -- 5 MB Base64 wären rund
// 6,7 MB Text, um Größenordnungen zu viel.
//
// Die Erlaubnis ist ein Token wie jedes andere in diesem System: nur sein
// SHA-256-Hash liegt in der Datenbank, der Wert selbst steht einmal in der
// Antwort von add_media und danach nirgends mehr. Sie ist einmalig, zehn
// Minuten gültig und an Log, Zielpfad und Konto gebunden -- wer sie
// abfängt, kann genau eine Datei an genau diese eine Stelle legen, und auch
// das nur, solange das Konto dort noch schreiben darf (die Route prüft das
// beim Hochladen erneut gegen GitHub, nicht nur beim Ausstellen).

import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { uploadToken } from './db/schema.ts';
import { randomToken, sha256Hex } from './oauth.ts';

export const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000; // zehn Minuten (spec §6)

export type MintUploadInput = { logId: string; path: string; accountId: number; contentType: string };

export function mintUploadToken(
  db: Db, input: MintUploadInput, nowIso: () => string = () => new Date().toISOString(),
): { token: string; expiresAt: string } {
  const token = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.parse(createdAt) + UPLOAD_TOKEN_TTL_MS).toISOString();
  db.insert(uploadToken).values({
    tokenHash: sha256Hex(token), logId: input.logId, path: input.path, accountId: input.accountId,
    contentType: input.contentType, expiresAt, consumedAt: null, createdAt,
  }).run();
  return { token, expiresAt };
}

export type RedeemUploadResult =
  | { ok: true; value: { logId: string; path: string; accountId: number; contentType: string } }
  | { ok: false; error: 'invalid_token' };

// Prüfen und verbrauchen in einem synchronen Durchlauf. Das ist der Grund,
// warum diese Funktion nicht async ist und auch nicht werden darf: zwei
// gleichzeitige PUTs mit demselben Token laufen hier nacheinander durch,
// der zweite sieht consumedAt gesetzt und fällt durch. Läge zwischen Lesen
// und Schreiben ein await, könnten beide dieselbe Erlaubnis benutzen.
//
// Verbraucht wird VOR dem Commit, nicht danach: ein Token, dessen Upload
// scheitert, ist aufgebraucht, und der Agent holt sich eine neue URL. Die
// andere Reihenfolge ließe einen fehlgeschlagenen Upload beliebig oft
// wiederholen -- und genau das ist das Fenster, das "einmalig" schließt.
export function redeemUploadToken(db: Db, token: string, nowMs: () => number = Date.now): RedeemUploadResult {
  const now = nowMs();
  const row = db.select().from(uploadToken).where(eq(uploadToken.tokenHash, sha256Hex(token))).all()[0];
  if (!row) return { ok: false, error: 'invalid_token' };
  if (row.consumedAt !== null) return { ok: false, error: 'invalid_token' };
  if (Date.parse(row.expiresAt) <= now) return { ok: false, error: 'invalid_token' };
  db.update(uploadToken).set({ consumedAt: new Date(now).toISOString() })
    .where(eq(uploadToken.tokenHash, row.tokenHash)).run();
  return { ok: true, value: { logId: row.logId, path: row.path, accountId: row.accountId, contentType: row.contentType } };
}

// Ein Zielpfad, wie add_media ihn annimmt, auf die eine Form gebracht, die
// dieser Dienst je schreibt: media/<Dateiname>. 'x.png' und 'media/x.png'
// meinen dasselbe; alles mit weiterer Pfadstruktur (auch '..') meint nichts
// Erlaubtes. null heißt "kein gültiger Zielpfad", nie "irgendwie schon".
export function normalizeMediaPath(path: string): string | null {
  const withoutPrefix = path.startsWith('media/') ? path.slice('media/'.length) : path;
  if (withoutPrefix === '' || withoutPrefix === '.' || withoutPrefix === '..') return null;
  if (withoutPrefix.includes('/') || withoutPrefix.includes('\\')) return null;
  return `media/${withoutPrefix}`;
}
