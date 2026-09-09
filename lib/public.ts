// Requests to [status, body]. No sockets here, so every route is a plain
// function call in a test. The JSON shape is the reference project's, scoped
// by log id (spec §7).

import type { Reader } from './store.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';
import { sortReleases, latestOf } from './order.ts';
import { sectionsOf } from './sections.ts';

export type Viewer = 'public' | 'member';
export type Reply = { status: number; body: unknown };

const NOT_FOUND: Reply = { status: 404, body: { error: 'not_found' } };

function visible(releases: ReleaseDoc[], viewer: Viewer): ReleaseDoc[] {
  return viewer === 'member' ? releases : releases.filter((r) => r.published_at !== null);
}

// image.src is a repo-relative path (e.g. "media/my file.png") and can
// contain characters a URL can't carry raw. Encode each segment so the
// emitted URL is re-requestable and decodes back to the original path;
// encoding the whole string in one call would also escape the "/" and
// break the route match on the way back in.
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// covered is the agent's bookkeeping, not part of the feed (spec §7).
function detail(release: ReleaseDoc, config: LogConfig): Record<string, unknown> {
  const { changes, covered, image, ...rest } = release;
  return {
    ...rest,
    url: `/l/${config.id}/releases/${encodeURIComponent(release.version)}`,
    image: image === null ? null : { src: `/l/${config.id}/media/${encodePath(image.src)}`, alt: image.alt },
    sections: sectionsOf(changes),
  };
}

const PER_PAGE_DEFAULT = 10;
const PER_PAGE_MAX = 100;

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number | null {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return value <= max ? value : null;
}

// The feed carries counts, not entries: a single release can hold hundreds.
function feedItem(release: ReleaseDoc, config: LogConfig): Record<string, unknown> {
  const full = detail(release, config);
  const sections = full.sections as { key: string; label: string; items: unknown[] }[];
  return {
    ...full,
    sections: sections.map((s) => ({ key: s.key, label: s.label, count: s.items.length })),
  };
}

export function route(
  method: string,
  pathname: string,
  params: URLSearchParams,
  reader: Reader,
  viewer: Viewer,
): Reply {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (pathname === '/health') return { status: 200, body: { status: 'ok' } };

  const match = /^\/l\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return NOT_FOUND;
  const [, logId, rest] = match;

  const config = reader.config(logId);
  if (!config) return NOT_FOUND;
  // A private log and a missing one answer identically (spec §7).
  if (config.visibility === 'private' && viewer !== 'member') return NOT_FOUND;

  const releases = visible(reader.releases(logId), viewer);

  if (rest === 'versions') {
    const sorted = sortReleases(releases);
    const newest = viewer === 'member' ? (sorted[0] ?? null) : latestOf(releases);
    return {
      status: 200,
      body: {
        product: config.product,
        latest: newest?.version ?? null,
        versions: sorted.map((r) => ({
          version: r.version,
          date: r.date,
          headline: r.headline,
          url: `/l/${config.id}/releases/${encodeURIComponent(r.version)}`,
        })),
      },
    };
  }

  if (rest === 'releases') {
    const page = intParam(params, 'page', 1, 1e6);
    const perPage = intParam(params, 'per_page', PER_PAGE_DEFAULT, PER_PAGE_MAX);
    if (page === null || perPage === null) return { status: 400, body: { error: 'bad_request' } };

    const sorted = sortReleases(releases);
    const offset = (page - 1) * perPage;
    return {
      status: 200,
      body: {
        product: config.product,
        page,
        per_page: perPage,
        total: sorted.length,
        total_pages: Math.max(1, Math.ceil(sorted.length / perPage)),
        releases: sorted.slice(offset, offset + perPage).map((r) => feedItem(r, config)),
      },
    };
  }

  const one = /^releases\/(.+)$/.exec(rest);
  if (one) {
    // pathname is percent-encoded (new URL never decodes it), so the version
    // segment has to be decoded once, here, to match the raw version emitted
    // by detail()/versions above. Exactly one decode, at the point of use —
    // same rule server.ts follows for the media path segment; never decode
    // twice. decodeURIComponent throws on a malformed escape like %zz; that
    // is a 404, not a crashed request.
    let version: string;
    try {
      version = decodeURIComponent(one[1]);
    } catch {
      return NOT_FOUND;
    }
    const found = releases.find((r) => r.version === version);
    return found ? { status: 200, body: detail(found, config) } : NOT_FOUND;
  }

  return NOT_FOUND;
}
