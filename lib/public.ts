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

// covered is the agent's bookkeeping, not part of the feed (spec §7).
function detail(release: ReleaseDoc, config: LogConfig): Record<string, unknown> {
  const { changes, covered, image, ...rest } = release;
  return {
    ...rest,
    url: `/l/${config.id}/releases/${release.version}`,
    image: image === null ? null : { src: `/l/${config.id}/media/${image.src}`, alt: image.alt },
    sections: sectionsOf(changes),
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
          url: `/l/${logId}/releases/${r.version}`,
        })),
      },
    };
  }

  const one = /^releases\/(.+)$/.exec(rest);
  if (one) {
    const found = releases.find((r) => r.version === one[1]);
    return found ? { status: 200, body: detail(found, config) } : NOT_FOUND;
  }

  return NOT_FOUND;
}
