import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from './config.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n';
const B64 = Buffer.from(PEM, 'utf8').toString('base64');

const COMPLETE = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: B64,
  GITHUB_WEBHOOK_SECRET: 'shhh',
  BASE_URL: 'https://release-log.czpt.de',
};

test('readConfig decodes the base64 private key back to PEM', () => {
  const config = readConfig(COMPLETE);
  assert.equal(config.privateKey, PEM);
  assert.equal(config.appId, '12345');
});

test('readConfig names every missing variable at once', () => {
  try {
    readConfig({ GITHUB_APP_ID: '12345' });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'BASE_URL']) {
      assert.ok(message.includes(name), `expected ${name} in: ${message}`);
    }
    assert.ok(!message.includes('GITHUB_APP_ID'), 'a variable that is present must not be reported missing');
    // Ensure no actual secret values appear in the error message
    assert.ok(!message.includes('shhh'), 'the webhook secret must not appear in an error');
    assert.ok(!message.includes('https://release-log.czpt.de'), 'the base URL must not appear in an error');
  }
});

test('readConfig rejects a private key that is not PEM after decoding', () => {
  const notPem = Buffer.from('hello', 'utf8').toString('base64');
  assert.throws(
    () => readConfig({ ...COMPLETE, GITHUB_APP_PRIVATE_KEY: notPem }),
    /PRIVATE KEY/,
  );
});

test('the thrown message never contains a secret value on missing variables', () => {
  try {
    readConfig({ ...COMPLETE, GITHUB_APP_PRIVATE_KEY: undefined });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes('shhh'), 'the webhook secret must not appear in an error');
  }
});

test('the thrown message never contains a secret value on PEM validation failure', () => {
  // Use a valid base64 string that decodes to something that is NOT a PEM block
  const notPemDecoded = 'this is not a key';
  const notPemB64 = Buffer.from(notPemDecoded, 'utf8').toString('base64');
  try {
    readConfig({ ...COMPLETE, GITHUB_APP_PRIVATE_KEY: notPemB64 });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    // Ensure neither the base64 nor the decoded text appears in the error
    assert.ok(
      !message.includes(notPemB64),
      `the base64-encoded key must not appear in error message: ${message}`,
    );
    assert.ok(
      !message.includes(notPemDecoded),
      `the decoded key must not appear in error message: ${message}`,
    );
  }
});

test('readConfig treats empty string as missing variable', () => {
  try {
    readConfig({ ...COMPLETE, GITHUB_WEBHOOK_SECRET: '' });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(message.includes('GITHUB_WEBHOOK_SECRET'), `expected GITHUB_WEBHOOK_SECRET in: ${message}`);
    // Ensure no actual value appears
    assert.ok(!message.includes('shhh'), 'the webhook secret must not appear in an error');
  }
});
