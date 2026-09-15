import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPkce } from './pkce.ts';

test('a matching S256 verifier/challenge pair verifies', () => {
  // Computed with: createHash('sha256').update(verifier, 'ascii').digest('base64url')
  const verifier = 'test-verifier-1234567890123456789012345';
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
