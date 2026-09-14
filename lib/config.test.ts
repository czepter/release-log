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
  GITHUB_CLIENT_ID: 'Iv1.deadbeef',
  GITHUB_CLIENT_SECRET: 'client-secret-value',
  SIGNING_KEY: 'a-long-random-signing-key',
  ADMIN_LOGINS: 'czepter, someone-else',
};

test('readConfig decodes the base64 private key back to PEM', () => {
  const config = readConfig(COMPLETE);
  assert.equal(config.privateKey, PEM);
  assert.equal(config.appId, '12345');
});

test('readConfig names every missing variable at once', () => {
  try {
    readConfig({ GITHUB_APP_ID: 'app-id-must-not-appear-in-errors' });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'BASE_URL']) {
      assert.ok(message.includes(name), `expected ${name} in: ${message}`);
    }
    assert.ok(!message.includes('GITHUB_APP_ID'), 'a variable that is present must not be reported missing');
    assert.ok(!message.includes('app-id-must-not-appear-in-errors'), 'the present variable value must not appear in the error message');
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
  }
});

test('readConfig passes clientId, clientSecret and signingKey through unchanged', () => {
  const config = readConfig(COMPLETE);
  assert.equal(config.clientId, 'Iv1.deadbeef');
  assert.equal(config.clientSecret, 'client-secret-value');
  assert.equal(config.signingKey, 'a-long-random-signing-key');
});

test('readConfig splits ADMIN_LOGINS on commas and trims whitespace', () => {
  const config = readConfig(COMPLETE);
  assert.deepEqual(config.adminLogins, ['czepter', 'someone-else']);
});

test('readConfig rejects an ADMIN_LOGINS that names nobody after trimming', () => {
  assert.throws(
    () => readConfig({ ...COMPLETE, ADMIN_LOGINS: ' , , ' }),
    /ADMIN_LOGINS/,
  );
});

test('readConfig names all four new variables when missing, alongside the old ones', () => {
  try {
    readConfig({});
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SIGNING_KEY', 'ADMIN_LOGINS']) {
      assert.ok(message.includes(name), `expected ${name} in: ${message}`);
    }
  }
});

test('the thrown message never contains the client secret or signing key on missing variables', () => {
  try {
    readConfig({ ...COMPLETE, GITHUB_CLIENT_SECRET: undefined, BASE_URL: undefined });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes('a-long-random-signing-key'), 'the signing key must not appear in an error');
  }
});
