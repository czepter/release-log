// PKCE (RFC 7636). S256 ist die einzige unterstützte Methode -- spec §5
// macht das zur Pflicht, nicht zur Kür: ein Aufruf mit "plain" oder
// irgendetwas anderem ist immer ungültig, unabhängig vom Wert.
import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const computed = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const given = Buffer.from(codeChallenge, 'utf8');
  const expected = Buffer.from(computed, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
