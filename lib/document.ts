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
