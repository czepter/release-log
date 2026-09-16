import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease } from '../../../lib/document.ts';
import type { ReleaseDoc } from '../../../lib/document.ts';
import { toBlocks, fromBlocks, newChange } from './releaseBlocks.ts';

const DOC: ReleaseDoc = {
  version: '0.5.0', tag: 'v0.5.0', date: '2026-09-16', published_at: '2026-09-16T10:00:00Z', commits: 7,
  headline: 'Logs anlegen, ohne das Dashboard zu verlassen',
  body: ['Ein neues Log braucht kein Repository mehr.', 'Größer & kleiner: <tag> bleibt Text.'],
  image: { src: 'media/dialog.png', alt: 'Der Dialog' },
  covered: ['abc123', 'def456'],
  changes: [
    { type: 'feat', breaking: false, scope: 'mcp', title: 'create_log', description: 'Absatz eins.\n\nAbsatz zwei.', pr: 12, issues: [3, 4], commit: 'abc123', date: '2026-09-15' },
    { type: 'perf', breaking: false, scope: null, title: 'Schneller', description: 'Eine Runde.', pr: null, issues: [], commit: 'def456', date: '2026-09-15' },
    { type: 'fix', breaking: true, scope: 'auth', title: 'Anmeldung', description: 'Neu anmelden.', pr: null, issues: [], commit: 'manuell', date: '2026-09-16' },
  ],
};

// Fällt, wenn covered, commits oder published_at beim Speichern verloren
// gehen -- der Editor zeigt sie nie, also darf er sie nie verändern.
test('a document survives the round trip through editor blocks unchanged', () => {
  const { head, blocks } = toBlocks(DOC);
  const parsed = parseRelease(fromBlocks(head, blocks, DOC), '0.5.0.json');
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '));
  if (parsed.ok) assert.deepEqual(parsed.value, DOC);
});

test('paragraph blocks hold escaped HTML, and inline markup from the editor comes back as plain text', () => {
  const { blocks } = toBlocks(DOC);
  assert.deepEqual(blocks[1], { type: 'paragraph', data: { text: 'Größer &amp; kleiner: &lt;tag&gt; bleibt Text.' } });
  const out = fromBlocks({ version: '1', tag: '', date: '2026-01-01', headline: 'h' }, [
    { type: 'paragraph', data: { text: 'Mit <b>fett</b>&nbsp;und <a href="x">Link</a> &amp; mehr' } },
    { type: 'paragraph', data: { text: '   ' } },
  ], null) as ReleaseDoc;
  assert.deepEqual(out.body, ['Mit fett und Link & mehr']);
  assert.equal(out.tag, null);
});

// Fällt, wenn der letzte Bildblock gewinnt.
test('only the first image block becomes the release image; an image without src is none', () => {
  const head = { version: '1', tag: '', date: '2026-01-01', headline: 'h' };
  const two = fromBlocks(head, [
    { type: 'releaseImage', data: { src: 'media/a.png', alt: 'A' } },
    { type: 'releaseImage', data: { src: 'media/b.png', alt: 'B' } },
  ], null) as ReleaseDoc;
  assert.deepEqual(two.image, { src: 'media/a.png', alt: 'A' });
  const empty = fromBlocks(head, [{ type: 'releaseImage', data: { src: '', alt: '' } }], null) as ReleaseDoc;
  assert.equal(empty.image, null);
});

test('a new release starts unpublished with no covered commits; a new change is valid once titled', () => {
  const change = { ...newChange('2026-09-16'), title: 'T', description: 'D' };
  assert.equal(change.commit, 'manuell');
  const doc = fromBlocks({ version: '1.0.0', tag: 'v1.0.0', date: '2026-09-16', headline: 'H' }, [{ type: 'change', data: change }], null);
  const parsed = parseRelease(doc, '1.0.0.json');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.published_at, null);
    assert.deepEqual(parsed.value.covered, []);
    assert.equal(parsed.value.changes[0].scope, null);
  }
});
