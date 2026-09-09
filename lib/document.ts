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

  // The id is interpolated into every emitted URL and looked up undecoded on
  // the way back in, so it has to survive that round trip unchanged. This is
  // a charset rule, not a format rule: the service generates Crockford
  // base32, but a hand-written id is fine as long as a URL can carry it.
  const ID = /^[A-Za-z0-9._~-]{1,64}$/;

  if (!str(input.id) || !ID.test(input.id)) {
    errors.push('config.id: required, 1-64 chars from A-Z a-z 0-9 . _ ~ -');
  }
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
  changes: Change[];
};

export type ChangeType = 'feat' | 'perf' | 'fix';

export type Change = {
  type: ChangeType;
  breaking: boolean;
  scope: string | null;
  title: string;
  description: string;
  pr: number | null;
  issues: number[];
  commit: string;
  date: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CHANGE_TYPES = ['feat', 'perf', 'fix'];

function parseChange(input: unknown, i: number, errors: string[]): Change | null {
  const at = `release.changes[${i}]`;
  if (!isObject(input)) {
    errors.push(`${at}: not an object`);
    return null;
  }
  const before = errors.length;

  if (typeof input.type !== 'string' || !CHANGE_TYPES.includes(input.type)) {
    errors.push(`${at}.type: must be one of feat, perf, fix`);
  }
  if (!str(input.title)) errors.push(`${at}.title: required, non-empty string`);
  if (!str(input.description)) errors.push(`${at}.description: required, non-empty string`);
  if (!str(input.commit)) errors.push(`${at}.commit: required, non-empty string`);
  if (!str(input.date) || !DATE.test(input.date)) {
    errors.push(`${at}.date: required, format YYYY-MM-DD`);
  }

  // breaking says what the change demands of the reader; type says what it is.
  // Two questions, two fields (spec, decision 11).
  const breaking = input.breaking === undefined ? false : input.breaking;
  if (typeof breaking !== 'boolean') errors.push(`${at}.breaking: boolean`);

  const scope = input.scope === undefined ? null : input.scope;
  if (scope !== null && typeof scope !== 'string') errors.push(`${at}.scope: string or null`);

  const pr = input.pr === undefined ? null : input.pr;
  if (pr !== null && !Number.isInteger(pr)) errors.push(`${at}.pr: integer or null`);

  const issues = input.issues === undefined ? [] : input.issues;
  if (!Array.isArray(issues) || issues.some((x) => !Number.isInteger(x))) {
    errors.push(`${at}.issues: list of integers`);
  }

  if (errors.length > before) return null;
  return {
    type: input.type as ChangeType,
    breaking: breaking as boolean,
    scope: scope as string | null,
    title: input.title as string,
    description: input.description as string,
    pr: pr as number | null,
    issues: issues as number[],
    commit: input.commit as string,
    date: input.date as string,
  };
}

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

  let changes: Change[] = [];
  if (input.changes !== undefined) {
    if (!Array.isArray(input.changes)) {
      errors.push('release.changes: must be a list');
    } else {
      changes = input.changes
        .map((c, i) => parseChange(c, i, errors))
        .filter((c): c is Change => c !== null);
    }
  }

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
      changes,
    },
  };
}
