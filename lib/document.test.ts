import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './document.ts';

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
