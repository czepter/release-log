// Ordering for a set of releases. Since version is an opaque identifier
// (spec, decision 9), date carries the order and version only breaks ties —
// with the reference project's numeric collator, so 0.9.10 still precedes
// 0.9.2. Sorting happens here in JavaScript rather than in SQL: a log holds
// dozens of releases, not millions (spec §4).

import type { ReleaseDoc } from './document.ts';

const collator = new Intl.Collator(undefined, { numeric: true });

export function compareReleases(a: ReleaseDoc, b: ReleaseDoc): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return collator.compare(b.version, a.version);
}

export function sortReleases(releases: ReleaseDoc[]): ReleaseDoc[] {
  return [...releases].sort(compareReleases);
}

export function latestOf(releases: ReleaseDoc[]): ReleaseDoc | null {
  const published = releases.filter((r) => r.published_at !== null);
  return sortReleases(published)[0] ?? null;
}
