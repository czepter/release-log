import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt } from './appAuth.ts';
import type { AppConfig } from './config.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG: AppConfig = {
  appId: '12345',
  privateKey,
  webhookSecret: 'shhh',
  baseUrl: 'https://example.test',
};

function parts(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
  };
}

test('the jwt verifies against the public key', () => {
  const token = appJwt(CONFIG);
  const [h, p, signature] = token.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

test('the header declares RS256', () => {
  assert.equal(parts(appJwt(CONFIG)).header.alg, 'RS256');
});

test('the issuer is the app id', () => {
  assert.equal(parts(appJwt(CONFIG)).payload.iss, '12345');
});

test('iat is backdated and exp is under ten minutes out', () => {
  const now = 1_800_000_000;
  const { payload } = parts(appJwt(CONFIG, now));
  // GitHub rejects a token whose iat is in the future by even a second of
  // clock skew, and refuses any exp more than 10 minutes ahead.
  assert.ok((payload.iat as number) < now, 'iat must be backdated against clock skew');
  assert.ok((payload.exp as number) > now, 'exp must be in the future');
  assert.ok((payload.exp as number) - now <= 600, 'exp must be at most 10 minutes ahead');
});

test('a tampered payload no longer verifies', () => {
  const token = appJwt(CONFIG);
  const [h, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ iss: '99999' }), 'utf8').toString('base64url');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${forged}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), false);
});
