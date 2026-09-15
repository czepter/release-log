import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPkce, isValidCodeVerifier, isValidCodeChallenge } from './pkce.ts';

test('a matching S256 verifier/challenge pair verifies', () => {
  // Computed with: createHash('sha256').update(verifier, 'ascii').digest('base64url')
  const verifier = 'test-verifier-1234567890123456789012345';
  // 39 Zeichen, also nach RFC 7636 §4.1 zu kurz -- mit Absicht: verifyPkce
  // vergleicht nur und urteilt nie über die Form seiner Eingabe. Wer die
  // Form prüft, steht in isValidCodeVerifier und wird am Rand aufgerufen.
  const challenge = 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8';
  assert.equal(verifyPkce(verifier, challenge, 'S256'), true);
});

test('a wrong verifier fails', () => {
  const challenge = 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8';
  assert.equal(verifyPkce('not-the-right-verifier', challenge, 'S256'), false);
});

test('the "plain" method is never accepted, even with a matching value', () => {
  // "plain" would make the challenge equal to the verifier itself -- rejecting
  // the method outright, not comparing values, is the point (spec §5, S256 is Pflicht).
  assert.equal(verifyPkce('same-value', 'same-value', 'plain'), false);
});

test('an unknown method is rejected', () => {
  assert.equal(verifyPkce('v', 'c', 'S1'), false);
});

// RFC 7636 §4.1/§4.2: die Formprüfungen, die verifyPkce bewusst nicht macht.
test('a code_verifier of 43 to 128 unreserved characters is well-formed', () => {
  assert.equal(isValidCodeVerifier('a'.repeat(43)), true, '43 is the minimum, not one past it');
  assert.equal(isValidCodeVerifier('a'.repeat(128)), true, '128 is the maximum, not one past it');
  assert.equal(isValidCodeVerifier('aA0-._~'.repeat(7).slice(0, 43)), true, 'every unreserved character is allowed');
});

test('a code_verifier outside the length bounds is refused', () => {
  assert.equal(isValidCodeVerifier('a'.repeat(42)), false);
  assert.equal(isValidCodeVerifier('a'.repeat(129)), false);
  assert.equal(isValidCodeVerifier(''), false);
});

test('a code_verifier with characters outside the unreserved set is refused', () => {
  // '+', '/' und '=' sind klassisches base64, nicht base64url -- der
  // wahrscheinlichste Fehler eines Clients, der seinen Verifier falsch
  // kodiert, und genau der, den §4.1 ausschließt.
  for (const bad of ['+', '/', '=', ' ', '%', '\n']) {
    assert.equal(isValidCodeVerifier('a'.repeat(42) + bad), false, `"${bad}" must not be accepted`);
  }
});

test('an S256 code_challenge is exactly 43 base64url characters', () => {
  assert.equal(isValidCodeChallenge('X_sK_G4Dyklp20kbAx-LJ1PgccfIg7q9182mvWIO9U0'), true);
  assert.equal(isValidCodeChallenge(''), false);
  assert.equal(isValidCodeChallenge('abc'), false);
  assert.equal(isValidCodeChallenge('a'.repeat(44)), false);
  // Padding und klassisches base64 fallen auf: eine S256-Challenge ist
  // base64url ohne '='.
  assert.equal(isValidCodeChallenge('a'.repeat(42) + '='), false);
  assert.equal(isValidCodeChallenge('a'.repeat(42) + '+'), false);
});
