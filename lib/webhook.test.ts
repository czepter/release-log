import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, refsFor } from './webhook.ts';

const SECRET = 'not-the-real-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('a correctly signed body verifies', () => {
  const body = Buffer.from('{"zen":"hi"}', 'utf8');
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
});

test('a body signed with another secret does not verify', () => {
  const body = Buffer.from('{"zen":"hi"}', 'utf8');
  assert.equal(verifySignature(SECRET, body, sign(body, 'someone-elses-secret')), false);
});

test('a changed body does not verify against the old signature', () => {
  const signature = sign(Buffer.from('{"zen":"hi"}', 'utf8'));
  assert.equal(verifySignature(SECRET, Buffer.from('{"zen":"HI"}', 'utf8'), signature), false);
});

test('a missing or malformed signature header does not verify', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, ''), false);
  assert.equal(verifySignature(SECRET, body, 'deadbeef'), false, 'ohne sha256= ist es kein Header, den wir kennen');
  // Das beweist NICHT, dass die 'sha256='-Präfixprüfung existiert: ohne sie
  // baut verifySignature den erwarteten Wert als die volle Zeichenkette
  // 'sha256=<hex>' und vergleicht dagegen, also scheitert jeder Header ohne
  // dieses Präfix schon am Vergleich. Was hier tatsächlich geprüft wird, ist
  // nur "ein Header mit falschem Algorithmus-Präfix verifiziert nicht".
  assert.equal(verifySignature(SECRET, body, 'sha1=deadbeef'), false);
  assert.equal(verifySignature(SECRET, body, 'sha256=nothex!!'), false);
  assert.equal(verifySignature(SECRET, body, 'sha256=abc'), false, 'zu kurz, und timingSafeEqual wirft bei ungleicher Länge');
});

test('push names the repository it happened in', () => {
  assert.deepEqual(
    refsFor({ event: 'push', payload: { repository: { full_name: 'o/r' } } }),
    [{ owner: 'o', repo: 'r' }],
  );
});

test('a renamed repository is named by its new name', () => {
  // Der Abgleich verankert auf der Node-ID, findet den Log also wieder;
  // was der Webhook liefern muss, ist der Pfad, unter dem GitHub das Repo
  // jetzt kennt.
  assert.deepEqual(
    refsFor({
      event: 'repository',
      payload: { action: 'renamed', repository: { full_name: 'o/renamed' } },
    }),
    [{ owner: 'o', repo: 'renamed' }],
  );
});

test('a deleted repository is still reported, so the sync can freeze its log', () => {
  assert.deepEqual(
    refsFor({ event: 'repository', payload: { action: 'deleted', repository: { full_name: 'o/r' } } }),
    [{ owner: 'o', repo: 'r' }],
  );
});

test('an installation event names every repository it carries', () => {
  assert.deepEqual(
    refsFor({
      event: 'installation',
      payload: { action: 'created', repositories: [{ full_name: 'o/a' }, { full_name: 'o/b' }] },
    }),
    [{ owner: 'o', repo: 'a' }, { owner: 'o', repo: 'b' }],
  );
});

test('installation_repositories names both what was added and what was removed', () => {
  // Ein entzogenes Repository muss angestoßen werden, damit der Abgleich
  // 'no_installation' sieht und aufhört, es anzufassen.
  assert.deepEqual(
    refsFor({
      event: 'installation_repositories',
      payload: {
        action: 'removed',
        repositories_added: [{ full_name: 'o/added' }],
        repositories_removed: [{ full_name: 'o/removed' }],
      },
    }),
    [{ owner: 'o', repo: 'added' }, { owner: 'o', repo: 'removed' }],
  );
});

test('ping and anything unknown name nothing', () => {
  assert.deepEqual(refsFor({ event: 'ping', payload: { zen: 'hi' } }), []);
  assert.deepEqual(refsFor({ event: 'star', payload: { repository: { full_name: 'o/r' } } }), []);
});

test('a malformed payload names nothing instead of throwing', () => {
  // Was über die Leitung kommt, ist Eingabe, keine Zusicherung — auch mit
  // gültiger Signatur.
  assert.deepEqual(refsFor({ event: 'push', payload: null }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: {} }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: {} } }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: { full_name: 'no-slash' } } }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: { full_name: 'a/b/c' } } }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: { full_name: '../../etc' } } }), []);
  assert.deepEqual(refsFor({ event: 'installation', payload: { repositories: 'nope' } }), []);
});
