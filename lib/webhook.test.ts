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

test('a full_name that is not a real GitHub owner/repo names nothing, even when it looks like two segments', () => {
  // Diese Werte landen roh in einem API-Pfad (Task 7). Jeder hier ist ein
  // Weg, den ein Blocklist-Ansatz übersehen hätte:
  const pushOf = (fullName: string) => refsFor({ event: 'push', payload: { repository: { full_name: fullName } } });
  // new URL() und fetch() wenden WHATWG dot-segment removal an und behandeln
  // '%2e' als '.' — das wäre also '../x', kein 'literales' '%2e%2e/x'.
  assert.deepEqual(pushOf('%2e%2e/x'), []);
  // '?' beginnt einen Query-String, keinen Pfad-Bestandteil.
  assert.deepEqual(pushOf('a/b?x=1'), []);
  // Ein rohes Leerzeichen ist in keinem der beiden GitHub-Zeichensets erlaubt.
  assert.deepEqual(pushOf('a b/c'), []);
  // GitHub-Owner sind höchstens 39 Zeichen lang.
  assert.deepEqual(pushOf(`${'a'.repeat(40)}/x`), []);
  // GitHub-Repository-Namen sind höchstens 100 Zeichen lang.
  assert.deepEqual(pushOf(`x/${'a'.repeat(101)}`), []);
  // '.' ist im Owner-Zeichensatz gar nicht enthalten (anders als im
  // Repository-Zeichensatz).
  assert.deepEqual(pushOf('foo.bar/repo'), []);
  // Das Repository-Zeichenset allein ließe ein Repo-Segment von genau '.'
  // oder '..' durch — beides gültige Zeichen im Zeichensatz, aber keine
  // Namen, die GitHub je vergäbe.
  assert.deepEqual(pushOf('o/.'), []);
  assert.deepEqual(pushOf('o/..'), []);
});

test('a realistic owner/repo with dots, underscores, and hyphens still comes through', () => {
  // Die Positivkontrolle: die Positivliste darf nicht so eng geraten sein,
  // dass sie echte GitHub-Namen ablehnt.
  assert.deepEqual(
    refsFor({ event: 'push', payload: { repository: { full_name: 'some-org/my_repo.v2' } } }),
    [{ owner: 'some-org', repo: 'my_repo.v2' }],
  );
});
