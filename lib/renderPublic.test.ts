import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicPage, renderReleaseFull, renderTimeline } from './renderPublic.ts';
import type { ReleaseDoc } from './document.ts';

const RELEASE: ReleaseDoc = {
  version: '1.0.0', tag: null, date: '2026-09-01', published_at: '2026-09-01T00:00:00.000Z', commits: 3,
  headline: 'Schnellere Suche', body: ['Ein Absatz.'], image: null, covered: [],
  changes: [
    { type: 'feat', breaking: false, scope: null, title: 'Volltextsuche', description: 'x', pr: 42, issues: [], commit: 'a', date: '2026-09-01' },
    { type: 'fix', breaking: true, scope: 'api', description: 'y', title: '<script>x</script>', pr: null, issues: [7], commit: 'b', date: '2026-09-01' },
  ],
};

test('publicPage sets noindex only when asked', () => {
  assert.ok(!publicPage('T', 'B').includes('noindex'));
  assert.ok(publicPage('T', 'B', { noindex: true }).includes('noindex'));
});

test('publicPage escapes an HTML-bearing title', () => {
  const html = publicPage('<script>xss</script>', 'B');
  assert.ok(!html.includes('<script>xss</script>'));
  assert.ok(html.includes('&lt;script&gt;xss&lt;/script&gt;'));
});

test('renderReleaseFull groups a breaking fix under "Wichtig", not also under "Behoben"', () => {
  const html = renderReleaseFull('log1', RELEASE);
  assert.ok(html.includes('Wichtig'));
  const behobenIndex = html.indexOf('Behoben');
  assert.equal(behobenIndex, -1, 'a breaking fix must not ALSO appear under its own type section');
});

test('renderReleaseFull escapes a change title containing HTML', () => {
  const html = renderReleaseFull('log1', RELEASE);
  assert.ok(!html.includes('<script>x</script>'));
});

test('renderReleaseFull escapes a change scope containing HTML', () => {
  const release: ReleaseDoc = {
    ...RELEASE,
    changes: [{ ...RELEASE.changes[0], scope: '<img src=x onerror=alert(1)>' }],
  };
  const html = renderReleaseFull('log1', release);
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
});

test('renderReleaseFull escapes a change description containing HTML', () => {
  const release: ReleaseDoc = {
    ...RELEASE,
    changes: [{ ...RELEASE.changes[0], description: '<svg onload=alert(1)>' }],
  };
  const html = renderReleaseFull('log1', release);
  assert.ok(!html.includes('<svg onload=alert(1)>'));
});

test('renderReleaseFull escapes the headline', () => {
  const release: ReleaseDoc = { ...RELEASE, headline: '<script>hl</script>' };
  const html = renderReleaseFull('log1', release);
  assert.ok(!html.includes('<script>hl</script>'));
});

test('renderReleaseFull escapes the date', () => {
  const release: ReleaseDoc = { ...RELEASE, date: '<script>dt</script>' };
  const html = renderReleaseFull('log1', release);
  assert.ok(!html.includes('<script>dt</script>'));
});

test('renderReleaseFull escapes every body paragraph independently, not just the first', () => {
  const release: ReleaseDoc = { ...RELEASE, body: ['<script>p0</script>', '<script>p1</script>'] };
  const html = renderReleaseFull('log1', release);
  assert.ok(!html.includes('<script>p0</script>'));
  assert.ok(!html.includes('<script>p1</script>'));
});

test('renderReleaseFull escapes image.alt in text context and URL-encodes image.src in the src attribute', () => {
  const release: ReleaseDoc = { ...RELEASE, image: { src: 'media/my file.png', alt: '<script>alt</script>' } };
  const html = renderReleaseFull('log1', release);
  assert.ok(!html.includes('<script>alt</script>'), 'alt must be HTML-escaped, not left raw');
  assert.ok(html.includes('media/my%20file.png'), 'src must be URL-encoded, not HTML-escaped');
  assert.ok(!html.includes('media/my file.png'), 'a raw space in the src attribute would be wrong');
});

test('renderTimeline links each entry to its permalink', () => {
  const html = renderTimeline('log1', [RELEASE]);
  assert.ok(html.includes('/l/log1/r/1.0.0'));
});

test('renderTimeline marks a breaking release directly in the stream', () => {
  const html = renderTimeline('log1', [RELEASE]);
  assert.ok(html.includes('breaking'));
});

test('renderTimeline escapes the headline', () => {
  const release: ReleaseDoc = { ...RELEASE, headline: '<script>tl</script>' };
  const html = renderTimeline('log1', [release]);
  assert.ok(!html.includes('<script>tl</script>'));
});

test('renderTimeline escapes the date', () => {
  const release: ReleaseDoc = { ...RELEASE, date: '<script>td</script>' };
  const html = renderTimeline('log1', [release]);
  assert.ok(!html.includes('<script>td</script>'));
});

test('renderTimeline escapes the teaser (first body paragraph)', () => {
  const release: ReleaseDoc = { ...RELEASE, body: ['<script>teaser</script>'] };
  const html = renderTimeline('log1', [release]);
  assert.ok(!html.includes('<script>teaser</script>'));
});
