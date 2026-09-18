import test from 'node:test';
import assert from 'node:assert/strict';
import de from './de.ts';
import en from './en.ts';
import { interpolate, plural, sectionLabel } from './messages.ts';

type Tree = { [key: string]: unknown };

// Jeder Blattpfad beider Sprachen, damit ein fehlender oder zu viel
// geschriebener Schlüssel als Pfad im Fehler steht und nicht als "nicht tief gleich".
function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((item, i) => leaves(item, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Tree).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
  }
  throw new Error(`${path}: nur Strings, Objekte und Arrays gehören in die Nachrichten`);
}

const deLeaves = leaves(de);
const enLeaves = leaves(en);

test('both languages carry the same keys', () => {
  assert.deepEqual(enLeaves.map(([path]) => path), deLeaves.map(([path]) => path));
});

test('no message is empty', () => {
  for (const [path, text] of [...deLeaves, ...enLeaves]) {
    assert.ok(text.trim() !== '', `${path} ist leer`);
  }
});

test('a key interpolates the same placeholders in both languages', () => {
  const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const enByPath = new Map(enLeaves);
  for (const [path, text] of deLeaves) {
    assert.deepEqual(names(enByPath.get(path) ?? ''), names(text), `${path}: andere Platzhalter`);
  }
});

test('interpolate fills every placeholder and leaves unknown ones alone', () => {
  assert.equal(interpolate('Angemeldet als {login}', { login: 'octocat' }), 'Angemeldet als octocat');
  assert.equal(interpolate('{n} von {n}', { n: 2 }), '2 von 2');
  assert.equal(interpolate('Hallo {wer}', {}), 'Hallo {wer}');
  assert.equal(interpolate('ohne Platzhalter'), 'ohne Platzhalter');
});

test('plural picks the form and fills n', () => {
  assert.equal(plural(de.dashboard.logCount, 1), '1 Log');
  assert.equal(plural(de.dashboard.logCount, 4), '4 Logs');
  assert.equal(plural(en.dashboard.logCount, 1), '1 log');
  assert.equal(plural(en.dashboard.logCount, 0), '0 logs');
});

test('sectionLabel translates a known key and falls back to the label of the API', () => {
  assert.equal(sectionLabel(en, 'changed', 'Änderungen'), 'Changes');
  assert.equal(sectionLabel(de, 'new', 'Neu'), 'Neu');
  assert.equal(sectionLabel(en, 'sonstiges', 'Sonstiges'), 'Sonstiges');
});
