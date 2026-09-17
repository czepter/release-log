// Ein Release schreiben oder (un)veröffentlichen, für jeden Aufrufer gleich:
// das MCP-Werkzeug und der Editor im Dashboard (Entscheidung 28). Zwei
// Schreibwege mit je eigener Konflikt- und Rechteprüfung würden
// auseinanderlaufen; hier gibt es nur einen.

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release as releaseTable } from './db/schema.ts';
import type { Permissions } from './permissions.ts';
import type { GitHub, RepoRef } from './github.ts';
import { parseRelease } from './document.ts';

export type WriteDeps = {
  db: Db; perms: Permissions; gh: GitHub; onRepoWrite(ref: RepoRef): void; baseUrl: string;
};
export type Who = { accountId: number; login: string } | null;
export type WriteError = 'not_found' | 'log_frozen' | 'forbidden' | 'invalid_document' | 'conflict' | 'no_installation';
export type WriteResult =
  | { ok: true; commitSha: string; permalink: string }
  | { ok: false; error: WriteError; message: string; current?: { blobSha: string | null; document: unknown } };

type Writable = { ok: true; ref: RepoRef } | { ok: false; error: WriteError; message: string };

async function writableLog(d: WriteDeps, who: Who, logId: string): Promise<Writable> {
  const row = d.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
  if (!row) return { ok: false, error: 'not_found', message: `no such log: ${logId}` };
  // Frozen vor canWrite: das Repo ist unerreichbar, also wird kein
  // GitHub-Aufruf riskiert, der ohnehin nur scheitern kann.
  if (row.state === 'frozen') return { ok: false, error: 'log_frozen', message: 'this log is frozen; its repository is unreachable' };
  const ref = { owner: row.repoOwner, repo: row.repoName };
  const canWrite = who !== null && await d.perms.canWrite(who.accountId, who.login, row.publicId, ref);
  if (!canWrite) return { ok: false, error: 'forbidden', message: 'no write access to this repository' };
  return { ok: true, ref };
}

function releaseRow(db: Db, logId: string, version: string) {
  return db.select().from(releaseTable)
    .where(and(eq(releaseTable.logId, logId), eq(releaseTable.version, version))).all()[0];
}

const permalink = (d: WriteDeps, logId: string, version: string): string =>
  `${d.baseUrl}/l/${logId}/r/${encodeURIComponent(version)}`;

export async function writeRelease(
  d: WriteDeps, who: Who, logId: string, version: string, document: unknown, baseBlobSha: string | null,
): Promise<WriteResult> {
  const writable = await writableLog(d, who, logId);
  if (!writable.ok) return writable;

  const parsed = parseRelease(document, `${version}.json`);
  if (!parsed.ok) return { ok: false, error: 'invalid_document', message: parsed.errors.join('; ') };

  const existing = releaseRow(d.db, logId, version);
  // Blindes Überschreiben ist ausgeschlossen (spec §6): existiert die
  // Version schon UND wurde keine Basis mitgegeben, ist das ein Konflikt,
  // ohne dass überhaupt ein Netzwerk-Aufruf stattfindet.
  if (existing && !baseBlobSha) {
    return {
      ok: false, error: 'conflict', message: 'this version already exists; send its blob sha to replace it',
      current: { blobSha: existing.blobSha, document: JSON.parse(existing.doc) },
    };
  }

  const content = Buffer.from(JSON.stringify(parsed.value, null, 2), 'utf8');
  const result = await d.gh.putFile(writable.ref, `releases/${version}.json`, content, `write release ${version} via MCP`, baseBlobSha ?? null);
  if (result.kind === 'no_installation') {
    return { ok: false, error: 'no_installation', message: 'the GitHub App is not installed on this repository' };
  }
  if (result.kind === 'conflict') {
    const fresh = releaseRow(d.db, logId, version);
    return {
      ok: false, error: 'conflict', message: 'the release changed since it was last read',
      current: { blobSha: fresh?.blobSha ?? null, document: fresh ? JSON.parse(fresh.doc) : null },
    };
  }
  d.onRepoWrite(writable.ref);
  return { ok: true, commitSha: result.sha, permalink: permalink(d, logId, version) };
}

// Die Version existiert per Definition schon, also gibt es hier kein
// Basis-Konzept wie bei writeRelease: die bekannte blobSha ist immer die
// erwartete.
export async function setPublished(
  d: WriteDeps, who: Who, logId: string, version: string, publishedAt: string | null,
): Promise<WriteResult> {
  const writable = await writableLog(d, who, logId);
  if (!writable.ok) return writable;

  const existing = releaseRow(d.db, logId, version);
  if (!existing) return { ok: false, error: 'not_found', message: `no such version: ${version}` };

  const doc = { ...JSON.parse(existing.doc), published_at: publishedAt };
  const content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
  const message = `${publishedAt !== null ? 'publish' : 'unpublish'} release ${version} via MCP`;
  const result = await d.gh.putFile(writable.ref, `releases/${version}.json`, content, message, existing.blobSha);
  if (result.kind === 'no_installation') {
    return { ok: false, error: 'no_installation', message: 'the GitHub App is not installed on this repository' };
  }
  if (result.kind === 'conflict') {
    return { ok: false, error: 'conflict', message: 'the release changed since it was last read; call get_release and try again' };
  }
  d.onRepoWrite(writable.ref);
  return { ok: true, commitSha: result.sha, permalink: permalink(d, logId, version) };
}
