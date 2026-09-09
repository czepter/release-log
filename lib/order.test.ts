import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortReleases, latestOf } from './order.ts';
import type { ReleaseDoc } from './document.ts';

function rel(version: string, date: string, published = true): ReleaseDoc {
  return {
    version, tag: null, date,
    published_at: published ? '2026-01-01T00:00:00Z' : null,
    commits: 0, headline: version, body: [], image: null, covered: [], changes: [],
  };
}

test('sortReleases orders by date, newest first', () => {
  const out = sortReleases([rel('a', '2026-01-01'), rel('b', '2026-03-01')]);
  assert.deepEqual(out.map((r) => r.version), ['b', 'a']);
});

test('sortReleases breaks a date tie numerically, not lexically', () => {
  const out = sortReleases([rel('0.9.2', '2026-01-01'), rel('0.9.10', '2026-01-01')]);
  assert.deepEqual(out.map((r) => r.version), ['0.9.10', '0.9.2']);
});

test('sortReleases handles opaque versions on the same date', () => {
  const out = sortReleases([rel('r2', '2026-01-01'), rel('r10', '2026-01-01')]);
  assert.deepEqual(out.map((r) => r.version), ['r10', 'r2']);
});

test('sortReleases does not mutate its input', () => {
  const input = [rel('a', '2026-01-01'), rel('b', '2026-03-01')];
  sortReleases(input);
  assert.deepEqual(input.map((r) => r.version), ['a', 'b']);
});

test('latestOf ignores drafts', () => {
  const out = latestOf([rel('a', '2026-01-01'), rel('b', '2026-03-01', false)]);
  assert.equal(out?.version, 'a');
});

test('latestOf returns null when nothing is published', () => {
  assert.equal(latestOf([rel('a', '2026-01-01', false)]), null);
});
