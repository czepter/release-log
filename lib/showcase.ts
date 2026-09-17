// Das Changelog auf der Startseite (Spec 2026-09-17). Die Quelle ist die
// öffentliche Seite eines Logs, auf dieser oder einer anderen Instanz;
// gelesen wird ihre JSON-Fläche (lib/public.ts). Jeder Fehler heißt: kein
// Abschnitt. Die Startseite hängt nie an einem fremden Server.

export type ShowcaseSource = { origin: string; logId: string; pageUrl: string };

type Counts = { key: string; label: string; count: number }[];
type Image = { src: string; alt: string } | null;
type FeedItem = { version: string; date: string; headline: string; sections: Counts };
type Detail = { version: string; image: Image; sections: unknown[]; [field: string]: unknown };

export type ShowcaseTeaser = { version: string; date: string; headline: string; href: string; sections: Counts };
export type Showcase = {
  pageUrl: string;
  feedUrl: string;
  product: string;
  latest: Detail & { href: string };
  older: ShowcaseTeaser[];
};

const TIMEOUT_MS = 3000;
const OLDER_MAX = 2;

export function parseShowcaseUrl(raw: string | undefined): ShowcaseSource | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const match = /^\/l\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  let logId: string;
  try {
    logId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return { origin: url.origin, logId, pageUrl: `${url.origin}/l/${encodeURIComponent(logId)}` };
}

// Die Quelle liefert Pfade wie /l/<id>/media/…; auf dieser Seite müssen sie
// auf den Server der Quelle zeigen. Nur http(s): die Adresse kommt von fremd.
function absoluteImage(image: Image, origin: string): Image {
  if (!image) return null;
  try {
    const url = new URL(image.src, origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? { src: url.href, alt: image.alt } : null;
  } catch {
    return null;
  }
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`Status ${res.status}`);
  return res.json();
}

export async function loadShowcase(raw: string | undefined, fetchImpl: typeof fetch): Promise<Showcase | null> {
  if (!raw) return null;
  const source = parseShowcaseUrl(raw);
  if (!source) {
    console.warn('RL_SHOWCASE_URL ist keine Log-Seite (https://<host>/l/<id>)');
    return null;
  }
  const base = source.pageUrl;
  const href = (version: string) => `${base}/r/${encodeURIComponent(version)}`;
  try {
    const feed = (await getJson(`${base}/releases?per_page=${OLDER_MAX + 1}`, fetchImpl)) as { product?: unknown; releases?: unknown };
    if (typeof feed.product !== 'string' || !Array.isArray(feed.releases)) throw new Error('Feed ohne product oder releases');
    const [newest, ...rest] = feed.releases as FeedItem[];
    if (!newest) return null;

    const detail = (await getJson(`${base}/releases/${encodeURIComponent(newest.version)}`, fetchImpl)) as Detail;
    if (typeof detail?.version !== 'string' || !Array.isArray(detail.sections)) throw new Error('Release ohne sections');

    return {
      pageUrl: base,
      feedUrl: `${base}/releases`,
      product: feed.product,
      latest: { ...detail, image: absoluteImage(detail.image ?? null, source.origin), href: href(detail.version) },
      older: rest.slice(0, OLDER_MAX).map((r) => ({
        version: r.version, date: r.date, headline: r.headline, href: href(r.version), sections: r.sections,
      })),
    };
  } catch (err) {
    // Ohne URL: sie kann Zugangsdaten tragen, und der Betreiber kennt sie.
    console.warn(`Showcase-Log nicht abrufbar: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
