// PKCE (RFC 7636). S256 ist die einzige unterstützte Methode -- spec §5
// macht das zur Pflicht, nicht zur Kür: ein Aufruf mit "plain" oder
// irgendetwas anderem ist immer ungültig, unabhängig vom Wert.
import { createHash, timingSafeEqual } from 'node:crypto';

// RFC 7636 §4.1: ein code_verifier ist 43 bis 128 Zeichen lang und benutzt
// ausschließlich die unreservierten URL-Zeichen. Absichtlich NICHT in
// verifyPkce: diese Funktion vergleicht, sie urteilt nicht über die Form
// ihrer Eingabe -- die Formprüfung gehört an den Rand, wo eine Anfrage
// ankommt (redeemAuthorizationCode), damit eine Form-Verletzung dort als
// ungültige Anfrage abgewiesen wird, statt als Hash-Mismatch zu enden.
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidCodeVerifier(value: string): boolean {
  return CODE_VERIFIER.test(value);
}

// RFC 7636 §4.2: mit S256 ist die Challenge BASE64URL(SHA256(verifier)),
// also immer genau 43 Zeichen base64url, ohne Padding. Alles andere kann
// keine gültige S256-Challenge sein -- ein gepaddetes oder klassisch
// base64-kodiertes Feld fällt hier auf, statt erst beim Einlösen des Codes
// eine Minute später.
const CODE_CHALLENGE_S256 = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(value: string): boolean {
  return CODE_CHALLENGE_S256.test(value);
}

export function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const computed = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const given = Buffer.from(codeChallenge, 'utf8');
  const expected = Buffer.from(computed, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
