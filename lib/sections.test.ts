import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf } from './sections.ts';
import type { Change } from './document.ts';

function change(type: 'feat' | 'perf' | 'fix', breaking = false, title = 't'): Change {
  return {
    type, breaking, scope: null, title, description: 'd',
    pr: null, issues: [], commit: 'abc1234', date: '2026-01-01',
  };
}

test('sectionsOf maps the three types to their labels', () => {
  const out = sectionsOf([change('feat'), change('perf'), change('fix')]);
  assert.deepEqual(out.map((s) => s.key), ['new', 'changed', 'fixed']);
  assert.deepEqual(out.map((s) => s.label), ['Neu', 'Änderungen', 'Behoben']);
});

test('sectionsOf drops empty sections', () => {
  const out = sectionsOf([change('fix')]);
  assert.deepEqual(out.map((s) => s.key), ['fixed']);
});

test('sectionsOf puts breaking entries into Wichtig, first', () => {
  const out = sectionsOf([change('fix'), change('feat', true, 'breaks')]);
  assert.equal(out[0].key, 'important');
  assert.equal(out[0].label, 'Wichtig');
  assert.equal(out[0].items[0].title, 'breaks');
});

test('a breaking entry appears only in Wichtig', () => {
  const out = sectionsOf([change('feat', true, 'breaks'), change('feat', false, 'plain')]);
  const newSection = out.find((s) => s.key === 'new');
  assert.deepEqual(newSection?.items.map((i) => i.title), ['plain']);
  assert.equal(out.flatMap((s) => s.items).filter((i) => i.title === 'breaks').length, 1);
});

test('sectionsOf returns nothing for no changes', () => {
  assert.deepEqual(sectionsOf([]), []);
});
