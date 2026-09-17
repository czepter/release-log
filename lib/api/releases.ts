import { and, eq } from 'drizzle-orm';
import { release } from '../db/schema.ts';
import { logAccess } from '../access.ts';
import type { LoggedIn } from '../access.ts';
import { writeRelease, setPublished } from '../releaseWrites.ts';
import type { WriteResult } from '../releaseWrites.ts';
import type { Core, Reply } from './core.ts';
import { ok, fail, NOT_FOUND, FORBIDDEN, field, text } from './core.ts';

const STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403, log_frozen: 409, invalid_document: 400, conflict: 409, no_installation: 502,
};

function toReply(result: WriteResult): Reply {
  if (result.ok) return ok({ commit_sha: result.commitSha, permalink: result.permalink });
  return {
    status: STATUS[result.error],
    body: { error: result.error, message: result.message, ...(result.current ? { current: { blob_sha: result.current.blobSha, document: result.current.document } } : {}) },
  };
}

function writeDeps({ auth }: Core) {
  return { db: auth.db, perms: auth.perms, gh: auth.gh, onRepoWrite: auth.onRepoWrite, baseUrl: auth.baseUrl };
}

// Der Editor liest mit blob_sha, damit das Speichern weiß, wogegen es
// schreibt. Lesen darf auch ein Admin auf einem eingefrorenen Log.
export async function getRelease({ auth }: Core, who: LoggedIn, logId: string, version: string): Promise<Reply> {
  const access = await logAccess(auth, who, logId, { frozenAdmin: true });
  if (!access.ok) return access.status === 404 ? NOT_FOUND : FORBIDDEN;
  const row = auth.db.select().from(release)
    .where(and(eq(release.logId, logId), eq(release.version, version))).all()[0];
  if (!row) return fail(404, 'not_found', `Version ${version} gibt es nicht.`);
  return ok({ document: JSON.parse(row.doc), blob_sha: row.blobSha, frozen: access.row.state === 'frozen' });
}

export async function putRelease(core: Core, who: LoggedIn, logId: string, version: string, input: unknown): Promise<Reply> {
  const base = field(input, 'base_blob_sha');
  if (base !== undefined && base !== null && typeof base !== 'string') return fail(400, 'bad_request', 'base_blob_sha: string or null');
  return toReply(await writeRelease(writeDeps(core), who, logId, version, field(input, 'document'), text(input, 'base_blob_sha')));
}

export async function publishRelease(core: Core, who: LoggedIn, logId: string, version: string, published: boolean): Promise<Reply> {
  const at = published ? new Date().toISOString() : null;
  return toReply(await setPublished(writeDeps(core), who, logId, version, at));
}
