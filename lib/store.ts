// The seam between "where do releases come from" and "how are they served".
// Plan 1 fills it from a directory; Plan 2 fills it from the SQLite index
// without public.ts changing (spec §4, §9).

import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseConfig, parseRelease } from './document.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';
import { mediaTypeOf } from './mediaTypes.ts';

export type MediaBlob = { type: string; bytes: Buffer };
export type SyncError = { path: string; message: string };

export type Reader = {
  config(logId: string): LogConfig | null;
  releases(logId: string): ReleaseDoc[];
  media(logId: string, path: string): MediaBlob | null;
  errors(logId: string): SyncError[];
  // Problems with no log id to key them by: a release-log.json that fails
  // to parse (the log itself never gets an id) and a duplicate id (the
  // second directory is dropped before it can claim one). errors() can't
  // carry either, so the dashboard needs a second channel (spec §3, §10).
  problems(): SyncError[];
  // The commit the log was last read at, or null when there is no commit
  // to name. A directory of files has no head, so fileReader returns null
  // and the server simply omits the header (spec §7).
  etag(logId: string): string | null;
};

type Loaded = {
  dir: string;
  // Filesystem-resolved (symlink-free) form of `dir`, computed once at load
  // time so media() has a real-path boundary to compare against without
  // re-resolving on every request.
  realDir: string;
  config: LogConfig;
  releases: ReleaseDoc[];
  errors: SyncError[];
};

function loadLog(dir: string, problems: SyncError[]): Loaded | null {
  let config: LogConfig;
  try {
    const parsed = parseConfig(JSON.parse(readFileSync(join(dir, 'release-log.json'), 'utf8')));
    if (!parsed.ok) {
      // No log id yet -- this can't be reported through errors(logId), so
      // it goes on the id-less channel instead (spec §10: "Fehler im
      // Dashboard").
      problems.push({ path: dir, message: `invalid release-log.json: ${parsed.errors.join('; ')}` });
      return null;
    }
    config = parsed.value;
  } catch (err) {
    problems.push({ path: dir, message: `invalid release-log.json: ${(err as Error).message}` });
    return null;
  }

  let realDir: string;
  try {
    realDir = realpathSync(dir);
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
  return { dir, realDir, config, releases, errors };
}

export function fileReader(rootInput: string): Reader {
  // A relative root (the future default of './logs') must not silently
  // fail every media request: resolve() below always returns an absolute
  // path, so log.dir has to be absolute too or the prefix check compares
  // absolute against relative and rejects everything.
  const root = resolve(rootInput);
  const logs = new Map<string, Loaded>();
  const problems: SyncError[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
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
    const loaded = loadLog(dir, problems);
    if (!loaded) continue;
    // First claimant wins: a second repo with a taken id is not indexed,
    // and the dashboard names both repos and the id (spec §3).
    const existing = logs.get(loaded.config.id);
    if (existing) {
      problems.push({
        path: `${existing.dir}, ${loaded.dir}`,
        message: `duplicate id "${loaded.config.id}": kept ${existing.dir}, dropped ${loaded.dir}`,
      });
    } else {
      logs.set(loaded.config.id, loaded);
    }
  }

  return {
    config: (logId) => logs.get(logId)?.config ?? null,
    releases: (logId) => logs.get(logId)?.releases ?? [],
    errors: (logId) => logs.get(logId)?.errors ?? [],
    problems: () => problems,
    etag: () => null,
    media(logId, path) {
      const log = logs.get(logId);
      if (!log) return null;
      const target = resolve(log.dir, path);
      // resolve() collapses "..", so a path that leaves the log directory is
      // visible here and nowhere later. Cheap first gate, purely lexical.
      if (target !== log.dir && !target.startsWith(log.dir + sep)) return null;
      const type = mediaTypeOf(target);
      if (!type) return null;
      // resolve() never touches the filesystem, so a symlink inside the log
      // directory that points outside it still passes the lexical check
      // above. This service serves content from repositories, which can
      // contain symlinks, so the second gate resolves the real path and
      // re-checks the boundary. realpathSync throws for a missing file,
      // which is the same "not found" outcome as today.
      let real: string;
      try {
        real = realpathSync(target);
      } catch {
        return null;
      }
      if (real !== log.realDir && !real.startsWith(log.realDir + sep)) return null;
      try {
        return { type, bytes: readFileSync(real) };
      } catch {
        return null;
      }
    },
  };
}
