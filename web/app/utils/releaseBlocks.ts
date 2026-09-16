// Ein Release-Dokument und die Blöcke des Editors, hin und zurück. Rein,
// ohne Browser: dieselbe Datei läuft in node --test und im Editor.
// Was der Editor nicht zeigt (covered, commits, published_at), kommt beim
// Speichern unverändert aus dem gelesenen Stand zurück.

import type { ReleaseDoc, Change } from '../../../lib/document.ts';

export type Block =
  | { type: 'paragraph'; data: { text: string } }
  | { type: 'releaseImage'; data: { src: string; alt: string } }
  | { type: 'change'; data: Change };

export type Head = { version: string; tag: string; date: string; headline: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

// Editor.js liefert Absätze als Inline-HTML; body ist Klartext.
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
}

export function textToHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function newChange(date: string): Change {
  // commit ist Pflicht im Format; ein im Editor geschriebener Eintrag hat
  // keinen Commit, auf den er zeigen könnte.
  return { type: 'feat', breaking: false, scope: null, title: '', description: '', pr: null, issues: [], commit: 'manuell', date };
}

export function toBlocks(doc: ReleaseDoc): { head: Head; blocks: Block[] } {
  const blocks: Block[] = [
    ...doc.body.map((text): Block => ({ type: 'paragraph', data: { text: textToHtml(text) } })),
    ...(doc.image ? [{ type: 'releaseImage', data: { ...doc.image } } as Block] : []),
    ...doc.changes.map((change): Block => ({ type: 'change', data: { ...change, issues: [...change.issues] } })),
  ];
  return { head: { version: doc.version, tag: doc.tag ?? '', date: doc.date, headline: doc.headline }, blocks };
}

export function fromBlocks(head: Head, blocks: Block[], previous: ReleaseDoc | null): unknown {
  const body: string[] = [];
  let image: ReleaseDoc['image'] = null;
  let imageSeen = false;
  const changes: Change[] = [];
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const text = htmlToText(block.data.text ?? '');
      if (text) body.push(text);
    } else if (block.type === 'releaseImage') {
      // Das Dokument kennt genau ein Bild: der erste Block zählt.
      if (!imageSeen && block.data.src) image = { src: block.data.src, alt: block.data.alt.trim() }
      imageSeen = true;
    } else if (block.type === 'change') {
      const c = block.data;
      changes.push({
        type: c.type, breaking: c.breaking === true,
        scope: c.scope && c.scope.trim() ? c.scope.trim() : null,
        title: c.title.trim(), description: c.description.trim(),
        pr: Number.isInteger(c.pr) ? c.pr : null,
        issues: (c.issues ?? []).filter((n) => Number.isInteger(n)),
        commit: c.commit.trim() || 'manuell',
        date: c.date || head.date,
      });
    }
  }
  return {
    version: head.version.trim(),
    tag: head.tag.trim() || null,
    date: head.date,
    published_at: previous?.published_at ?? null,
    commits: previous?.commits ?? 0,
    headline: head.headline.trim(),
    body,
    image,
    covered: previous?.covered ?? [],
    changes,
  };
}
