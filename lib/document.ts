// Validation and normalisation of the two documents a log repo holds.
// Pure: no filesystem, no network. The index and the write path share it,
// so a document the index would reject never reaches the repo (spec §6).

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type LogView = 'full' | 'timeline';
export type LogVisibility = 'public' | 'private';

export type LogConfig = {
  id: string;
  product: string;
  view: LogView;
  visibility: LogVisibility;
  curation_notes: string | null;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function parseConfig(input: unknown): Validated<LogConfig> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['config: not an object'] };

  if (!str(input.id)) errors.push('config.id: required, non-empty string');
  if (!str(input.product)) errors.push('config.product: required, non-empty string');

  const view = input.view === undefined ? 'full' : input.view;
  if (view !== 'full' && view !== 'timeline') {
    errors.push('config.view: must be "full" or "timeline"');
  }

  const visibility = input.visibility === undefined ? 'public' : input.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    errors.push('config.visibility: must be "public" or "private"');
  }

  const notes = input.curation_notes === undefined ? null : input.curation_notes;
  if (notes !== null && typeof notes !== 'string') {
    errors.push('config.curation_notes: must be a string or null');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: input.id as string,
      product: input.product as string,
      view: view as LogView,
      visibility: visibility as LogVisibility,
      curation_notes: notes as string | null,
    },
  };
}

export type ReleaseImage = { src: string; alt: string };

export type ReleaseDoc = {
  version: string;
  tag: string | null;
  date: string;
  published_at: string | null;
  commits: number;
  headline: string;
  body: string[];
  image: ReleaseImage | null;
  covered: string[];
  changes: unknown[]; // Task 3 gives this a type
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function stringList(v: unknown, field: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errors.push(`${field}: must be a list of strings`);
    return [];
  }
  return v as string[];
}

export function parseRelease(input: unknown, filename?: string): Validated<ReleaseDoc> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['release: not an object'] };

  // version is an opaque identifier (spec, decision 9): "1.2.0", "2026-09-08"
  // and "r42" are equally valid. Only the tie to the filename is enforced.
  if (!str(input.version)) errors.push('release.version: required, non-empty string');
  if (filename !== undefined && str(input.version)) {
    const stem = filename.replace(/\.json$/, '');
    if (stem !== input.version) {
      errors.push(`release.version: "${input.version}" does not match filename "${stem}"`);
    }
  }

  if (!str(input.date) || !DATE.test(input.date)) {
    errors.push('release.date: required, format YYYY-MM-DD');
  }
  if (!str(input.headline)) errors.push('release.headline: required, non-empty string');

  const tag = input.tag === undefined ? null : input.tag;
  if (tag !== null && typeof tag !== 'string') errors.push('release.tag: string or null');

  const published = input.published_at === undefined ? null : input.published_at;
  if (published !== null && !(typeof published === 'string' && INSTANT.test(published))) {
    errors.push('release.published_at: ISO-8601 UTC instant or null');
  }

  const commits = input.commits === undefined ? 0 : input.commits;
  if (!Number.isInteger(commits) || (commits as number) < 0) {
    errors.push('release.commits: integer >= 0');
  }

  const body = stringList(input.body, 'release.body', errors);
  const covered = stringList(input.covered, 'release.covered', errors);

  let image: ReleaseImage | null = null;
  if (input.image !== undefined && input.image !== null) {
    if (!isObject(input.image) || !str(input.image.src) || !str(input.image.alt)) {
      errors.push('release.image: object with src and alt, or null');
    } else if (input.image.src.startsWith('/')) {
      // Repo-relative keeps the repo meaningful on its own (spec §3).
      errors.push('release.image.src: must be repo-relative, not absolute');
    } else {
      image = { src: input.image.src, alt: input.image.alt };
    }
  }

  const changes = input.changes === undefined ? [] : input.changes;
  if (!Array.isArray(changes)) errors.push('release.changes: must be a list');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: input.version as string,
      tag: tag as string | null,
      date: input.date as string,
      published_at: published as string | null,
      commits: commits as number,
      headline: input.headline as string,
      body,
      image,
      covered,
      changes: changes as unknown[],
    },
  };
}
