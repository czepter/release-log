// Die gehostete Seite (spec §7, "Gehostete Seite") -- reine Anzeige, keine
// Formulare, keine Schreibroute. Getrennt von lib/render.ts, weil diese
// Hülle keine Dashboard-Navigation trägt und private Logs ein
// noindex-Meta bekommen, das die Dashboard-Seiten nie brauchen.
import { escapeHtml, STYLE } from './render.ts';
import type { ReleaseDoc, Change } from './document.ts';
import { sectionsOf } from './sections.ts';
import type { Section } from './sections.ts';

export function publicPage(title: string, bodyHtml: string, options: { noindex?: boolean } = {}): string {
  const robots = options.noindex ? '<meta name="robots" content="noindex">' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${robots}<style>${STYLE}</style></head><body>${bodyHtml}</body></html>`;
}

// Dieselbe Segment-für-Segment-Kodierung wie lib/public.ts's detail() (dort
// privat) -- ein "/" bleibt ein echter Pfadtrenner, wird nie zu %2F. Drei
// Zeilen doppelt zu halten ist billiger als eine geteilte Naht über zwei
// unabhängige Dateien für eine Zeile, die sich nie ändert.
function encodeMediaPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function renderChange(c: Change): string {
  const scope = c.scope ? `<span class="muted">${escapeHtml(c.scope)}: </span>` : '';
  const breaking = c.breaking ? '<span class="badge">breaking</span> ' : '';
  const refs = [c.pr !== null ? `PR #${c.pr}` : null, ...c.issues.map((n) => `Issue #${n}`)]
    .filter((x): x is string => x !== null);
  return `<li>${breaking}${scope}<strong>${escapeHtml(c.title)}</strong><p>${escapeHtml(c.description)}</p>${
    refs.length > 0 ? `<p class="muted">${refs.map(escapeHtml).join(', ')}</p>` : ''
  }</li>`;
}

function renderSections(sections: Section[]): string {
  return sections.map((s) => `<h3>${escapeHtml(s.label)}</h3><ul>${s.items.map(renderChange).join('')}</ul>`).join('');
}

// Ein Release ausführlich: headline, body, Bild, dann die Abschnitte oben
// (spec §7, view: "full"). Dieselbe Form für jeden Permalink, unabhängig
// von der konfigurierten view des Logs -- wer dem Permalink folgt, will das
// ganze Release, nicht die Zusammenfassung aus dem Strom.
export function renderReleaseFull(logId: string, release: ReleaseDoc): string {
  const image = release.image
    ? `<p><img src="/l/${encodeURIComponent(logId)}/media/${encodeMediaPath(release.image.src)}" alt="${escapeHtml(release.image.alt)}"></p>`
    : '';
  return `
    <h2>${escapeHtml(release.headline)}</h2>
    <p class="muted">${escapeHtml(release.date)}${release.published_at === null ? ' &middot; <span class="badge">Entwurf</span>' : ''}</p>
    ${release.body.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
    ${image}
    ${renderSections(sectionsOf(release.changes))}
  `;
}

// Der Strom: geschlossene Einträge, der Permalink führt hinein (spec §7,
// view: "timeline"). Ein brechendes Release trägt sein Abzeichen direkt im
// Strom, ohne dass man erst hineinklicken muss.
export function renderTimeline(logId: string, releases: ReleaseDoc[]): string {
  const items = releases.map((r) => {
    const breaking = r.changes.some((c) => c.breaking) ? '<span class="badge">breaking</span> ' : '';
    const draft = r.published_at === null ? ' <span class="badge">Entwurf</span>' : '';
    const teaser = r.body.length > 0 ? `<p>${escapeHtml(r.body[0])}</p>` : '';
    return `<li>${breaking}<strong>${escapeHtml(r.date)}</strong> &mdash; <a href="/l/${encodeURIComponent(logId)}/r/${encodeURIComponent(r.version)}">${escapeHtml(r.headline)}</a>${draft}${teaser}</li>`;
  }).join('');
  return `<ul>${items}</ul>`;
}
