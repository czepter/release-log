// The seam between "where do releases come from" and "how are they served".
// Plan 1 fills it from a directory; Plan 2 fills it from the SQLite index
// without public.ts changing (spec §4, §9).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { parseConfig, parseRelease } from './document.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';

export type MediaBlob = { type: string; bytes: Buffer };
export type SyncError = { path: string; message: string };

export type Reader = {
  config(logId: string): LogConfig | null;
  releases(logId: string): ReleaseDoc[];
  media(logId: string, path: string): MediaBlob | null;
  errors(logId: string): SyncError[];
};

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

type Loaded = {
  dir: string;
  config: LogConfig;
  releases: ReleaseDoc[];
  errors: SyncError[];
};

function loadLog(dir: string): Loaded | null {
  let config: LogConfig;
  try {
    const parsed = parseConfig(JSON.parse(readFileSync(join(dir, 'release-log.json'), 'utf8')));
    if (!parsed.ok) return null;
    config = parsed.value;
  } catch {
    return null;
  }

  const releases: ReleaseDoc[] = [];
  const errors: SyncError[] = [];
  const releaseDir = join(dir, 'releases');
  let names: string[] = [];
  try {
    names = readdirSync(releaseDir).filter((n) => n.endsWith('.json'));
  } catch {
    names = [];
  }
  for (const name of names) {
    const path = join('releases', name);
    try {
      const raw = JSON.parse(readFileSync(join(releaseDir, name), 'utf8'));
      const parsed = parseRelease(raw, name);
      if (parsed.ok) releases.push(parsed.value);
      else errors.push({ path, message: parsed.errors.join('; ') });
    } catch (err) {
      // A hand edit in the repo must never take a public page down (spec §10).
      errors.push({ path, message: (err as Error).message });
    }
  }
  return { dir, config, releases, errors };
}

export function fileReader(root: string): Reader {
  const logs = new Map<string, Loaded>();
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    // root is filesystem input, a trust boundary: an unreadable or dangling
    // entry (e.g. a broken symlink) must be skipped, not crash startup.
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const loaded = loadLog(dir);
    // First claimant wins: a second repo with a taken id is not indexed
    // (spec §3).
    if (loaded && !logs.has(loaded.config.id)) logs.set(loaded.config.id, loaded);
  }

  return {
    config: (logId) => logs.get(logId)?.config ?? null,
    releases: (logId) => logs.get(logId)?.releases ?? [],
    errors: (logId) => logs.get(logId)?.errors ?? [],
    media(logId, path) {
      const log = logs.get(logId);
      if (!log) return null;
      const target = resolve(log.dir, path);
      // resolve() collapses "..", so a path that leaves the log directory is
      // visible here and nowhere later.
      if (target !== log.dir && !target.startsWith(log.dir + sep)) return null;
      const type = MEDIA_TYPES[extname(target)];
      if (!type) return null;
      try {
        return { type, bytes: readFileSync(target) };
      } catch {
        return null;
      }
    },
  };
}
