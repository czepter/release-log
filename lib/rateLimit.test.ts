import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimiter } from './rateLimit.ts';

test('allows up to the limit, then refuses', () => {
  const rl = rateLimiter(3, 60_000);
  assert.equal(rl.check('1.2.3.4'), true);
  assert.equal(rl.check('1.2.3.4'), true);
  assert.equal(rl.check('1.2.3.4'), true);
  assert.equal(rl.check('1.2.3.4'), false, 'the fourth call in the window must be refused');
});

test('keys are independent', () => {
  const rl = rateLimiter(1, 60_000);
  assert.equal(rl.check('a'), true);
  assert.equal(rl.check('b'), true, 'a different key must not share the first key\'s budget');
});

test('a new window resets the count', () => {
  let now = 0;
  const rl = rateLimiter(1, 1000, () => now);
  assert.equal(rl.check('k'), true);
  assert.equal(rl.check('k'), false);
  now = 1001;
  assert.equal(rl.check('k'), true, 'a call after the window boundary must be let through again');
});
