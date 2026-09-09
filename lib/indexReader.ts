// The index side of the Reader seam. lib/public.ts and server.ts do not
// know which implementation they were handed, which is the whole point of
// the seam (spec §4, §9).
//
// Note what is absent: no path guard. Media is keyed by exact path in a
// table, so "../" is a key that matches nothing rather than a filesystem
// traversal to defend against.

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release, media, syncError, problem } from './db/schema.ts';
import type { Reader, MediaBlob, SyncError } from './store.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';

// syncLog prefixes a sync error's message with the blob sha so a repeated
// sync can tell "same broken file" from "newly broken file" without
// re-fetching. That prefix is bookkeeping and never reaches a reader.
function stripSha(message: string): string {
  const match = /^sha:[0-9a-f]{40} (.*)$/s.exec(message);
  return match ? match[1] : message;
}

export function indexReader(db: Db): Reader {
  return {
    config(logId: string): LogConfig | null {
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      if (!row) return null;
      return {
        id: row.publicId,
        product: row.product,
        view: row.view as LogConfig['view'],
        visibility: row.visibility as LogConfig['visibility'],
        curation_notes: row.curationNotes,
      };
    },
    releases(logId: string): ReleaseDoc[] {
      return db.select().from(release).where(eq(release.logId, logId)).all()
        .map((row) => JSON.parse(row.doc) as ReleaseDoc);
    },
    media(logId: string, path: string): MediaBlob | null {
      const row = db.select().from(media)
        .where(and(eq(media.logId, logId), eq(media.path, path))).all()[0];
      if (!row) return null;
      return { type: row.contentType, bytes: Buffer.from(row.bytes) };
    },
    errors(logId: string): SyncError[] {
      return db.select().from(syncError).where(eq(syncError.logId, logId)).all()
        .map((row) => ({ path: row.path, message: stripSha(row.message) }));
    },
    problems(): SyncError[] {
      return db.select().from(problem).all()
        .map((row) => ({ path: row.path, message: row.message }));
    },
    etag(logId: string): string | null {
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      return row?.headSha ?? null;
    },
  };
}
