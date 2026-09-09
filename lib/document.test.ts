import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, parseRelease } from './document.ts';

test('parseConfig accepts a complete config', () => {
  const result = parseConfig({
    id: 'k7m2q9xw4p1a',
    product: 'Auri CRM',
    view: 'full',
    visibility: 'public',
    curation_notes: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, 'k7m2q9xw4p1a');
  assert.equal(result.value.view, 'full');
});

test('parseConfig defaults view and visibility', () => {
  const result = parseConfig({ id: 'k7m2q9xw4p1a', product: 'X' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.view, 'full');
  assert.equal(result.value.visibility, 'public');
  assert.equal(result.value.curation_notes, null);
});

test('parseConfig rejects an unknown view and names the field', () => {
  const result = parseConfig({ id: 'k7m2q9xw4p1a', product: 'X', view: 'grid' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('view')));
});

test('parseConfig rejects a missing id', () => {
  const result = parseConfig({ product: 'X' });
  assert.equal(result.ok, false);
});

const HEAD = {
  version: '0.9.2',
  tag: 'v0.9.2',
  date: '2026-09-08',
  published_at: '2026-09-08T14:22:00Z',
  commits: 4,
  headline: 'Galerie-Einstellungen an einer Stelle',
  body: ['Ein Absatz.'],
  image: { src: 'media/0.9.2.png', alt: 'Liste' },
  covered: ['b9871b32'],
  changes: [],
};

test('parseRelease accepts a complete head', () => {
  const result = parseRelease(HEAD);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.version, '0.9.2');
  assert.equal(result.value.published_at, '2026-09-08T14:22:00Z');
});

test('parseRelease treats a null published_at as a draft', () => {
  const result = parseRelease({ ...HEAD, published_at: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.published_at, null);
});

test('parseRelease defaults optional collections', () => {
  const result = parseRelease({
    version: 'r1', date: '2026-01-01', headline: 'X', commits: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.body, []);
  assert.deepEqual(result.value.covered, []);
  assert.deepEqual(result.value.changes, []);
  assert.equal(result.value.tag, null);
  assert.equal(result.value.image, null);
});

test('parseRelease accepts an opaque version such as a date', () => {
  const result = parseRelease({ ...HEAD, version: '2026-09-08' });
  assert.equal(result.ok, true);
});

test('parseRelease rejects a version that differs from the filename', () => {
  const result = parseRelease(HEAD, '0.9.1.json');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('filename')));
});

test('parseRelease rejects a malformed date', () => {
  const result = parseRelease({ ...HEAD, date: '08.09.2026' });
  assert.equal(result.ok, false);
});

test('parseRelease rejects an absolute image src', () => {
  const result = parseRelease({ ...HEAD, image: { src: '/media/x.png', alt: 'a' } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('image.src')));
});

test('parseRelease rejects a negative commit count', () => {
  const result = parseRelease({ ...HEAD, commits: -1 });
  assert.equal(result.ok, false);
});
