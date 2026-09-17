// Was jede Seiten-API-Funktion bekommt und zurückgibt. Kein HTTP: die
// h3-Routen unter web/server/api reichen nur Eingaben herein und schreiben
// das Ergebnis hinaus (Entscheidung 27).

import type { Auth } from '../../server.ts';
import type { Reader } from '../store.ts';

export type Core = { auth: Auth; reader: Reader };
export type Reply = { status: number; body: unknown };

export const ok = (body: unknown, status = 200): Reply => ({ status, body });
export const fail = (status: number, error: string, message: string): Reply => ({ status, body: { error, message } });

export const NOT_FOUND = fail(404, 'not_found', 'Dieses Log gibt es nicht.');
export const FORBIDDEN = fail(403, 'forbidden', 'Du hast keine Schreibrechte auf dieses Repository.');

// Eingaben kommen als geparstes JSON unbekannter Form.
export function field(input: unknown, name: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[name] : undefined;
}

export function text(input: unknown, name: string): string | null {
  const v = field(input, name);
  return typeof v === 'string' ? v : null;
}
