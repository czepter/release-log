import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cipher, readEncryptionKey } from './secrets.ts';

const KEY = Buffer.alloc(32, 5);

test('what goes in comes back out', () => {
  const box = cipher(KEY).encrypt('gho_a-github-user-token');
  assert.equal(cipher(KEY).decrypt(box), 'gho_a-github-user-token');
});

test('the ciphertext carries the plaintext nowhere in it', () => {
  const box = cipher(KEY).encrypt('gho_a-github-user-token');
  assert.ok(!box.includes('gho_'), `the token must not survive in the box: ${box}`);
});

test('the same value encrypts differently every time', () => {
  // Ein fester IV wäre der klassische GCM-Fehler: gleiche Token ergäben
  // gleiche Zeilen, und wer die Datenbank liest, sähe, wer sich denselben
  // Zugang teilt -- oder wessen Token sich seit gestern nicht geändert hat.
  const box = cipher(KEY);
  assert.notEqual(box.encrypt('same'), box.encrypt('same'));
});

test('a different key cannot read the box', () => {
  const box = cipher(KEY).encrypt('gho_a-github-user-token');
  assert.equal(cipher(Buffer.alloc(32, 6)).decrypt(box), null);
});

test('a tampered box is refused rather than half-decrypted', () => {
  // Genau dafür ist GCM da: eine veränderte Zeile darf nicht als Token
  // benutzt werden, sondern muss auffallen.
  const box = cipher(KEY).encrypt('gho_a-github-user-token');
  const parts = box.split('.');
  const bytes = Buffer.from(parts[3], 'base64url');
  bytes[0] ^= 0xff;
  parts[3] = bytes.toString('base64url');
  assert.equal(cipher(KEY).decrypt(parts.join('.')), null);
});

test('garbage, an empty string and a wrong version are refused without throwing', () => {
  const box = cipher(KEY);
  for (const bad of ['', 'nonsense', 'v2.a.b.c', 'v1.a.b', 'v1...', 'v1.a.b.c.d']) {
    assert.equal(box.decrypt(bad), null, `"${bad}" must decrypt to null`);
  }
});

test('an encryption key that is not 32 bytes is refused at startup', () => {
  assert.throws(() => readEncryptionKey(Buffer.alloc(31, 1).toString('base64')), /32 bytes/);
  assert.throws(() => readEncryptionKey(''), /32 bytes/);
  assert.throws(() => readEncryptionKey('not a key at all'), /32 bytes/);
  assert.deepEqual(readEncryptionKey(Buffer.alloc(32, 1).toString('base64')), Buffer.alloc(32, 1));
});

test('the hex key scripts/setup-github-app.sh writes is read as those 32 bytes', () => {
  // `openssl rand -hex 32` ist, was das Einrichtungsskript erzeugt. Als
  // base64 gelesen ergäbe derselbe Text 48 Bytes -- ein ausgerollter
  // Schlüssel würde beim Start abgelehnt, und jedes gespeicherte
  // Nutzer-Token wäre mit einem Deploy wertlos.
  const hex = Buffer.alloc(32, 0xab).toString('hex');
  assert.equal(hex.length, 64);
  assert.deepEqual(readEncryptionKey(hex), Buffer.alloc(32, 0xab));
});
