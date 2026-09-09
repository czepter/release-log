// The single place that changes the index. A write path, a webhook and a
// reconcile run all call this one function, so drift between them is not
// possible (spec §4).

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release, syncError, problem, media } from './db/schema.ts';
import type { GitHub, RepoRef, TreeEntry } from './github.ts';
import { parseConfig, parseRelease } from './document.ts';
import type { LogConfig } from './document.ts';
import { MEDIA_TYPES } from './store.ts';

const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

function mediaPaths(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((e) => e.path.startsWith('media/'));
}

// The extension is compared lower-cased so `shot.PNG` is the same file type
// as `shot.png` — a repo using that casing must not silently lose an image.
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

export type SyncOutcome = {
  logId: string | null;
  fetched: number;
  errors: number;
  frozen: boolean;
};

const CONFIG_PATH = 'release-log.json';

function now(): string {
  return new Date().toISOString();
}

function releasePaths(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((e) => e.path.startsWith('releases/') && e.path.endsWith('.json'));
}

// The problem and syncError upserts share one shape (insert, or overwrite
// the existing row for the same key) and are written at four call sites
// below; these two helpers keep that shape in one place.
function writeProblem(db: Db, path: string, message: string): void {
  db.insert(problem)
    .values({ path, message, at: now() })
    .onConflictDoUpdate({ target: problem.path, set: { message, at: now() } })
    .run();
}

function writeSyncError(db: Db, logId: string, path: string, message: string): void {
  db.insert(syncError)
    .values({ logId, path, message, at: now() })
    .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message, at: now() } })
    .run();
}

export async function syncLog(db: Db, gh: GitHub, ref: RepoRef): Promise<SyncOutcome> {
  const repoPath = `${ref.owner}/${ref.repo}`;
  const head = await gh.head(ref);

  // A repo that is gone freezes whatever log it carried; the last state
  // stays served and nothing is deleted (spec §10).
  if (head === null) {
    const existing = db.select().from(log)
      .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all();
    for (const row of existing) {
      db.update(log).set({ state: 'frozen' }).where(eq(log.publicId, row.publicId)).run();
    }
    return { logId: existing[0]?.publicId ?? null, fetched: 0, errors: 0, frozen: existing.length > 0 };
  }

  const tree = await gh.tree(ref, head);
  const configEntry = tree.find((e) => e.path === CONFIG_PATH);
  if (!configEntry) {
    writeProblem(db, repoPath, `no ${CONFIG_PATH} in ${repoPath}`);
    return { logId: null, fetched: 0, errors: 0, frozen: false };
  }

  const known = db.select().from(log)
    .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all()[0] ?? null;

  // Unchanged config: reuse what the index already holds instead of
  // fetching and re-parsing it.
  const configUnchanged = known !== null && known.configBlobSha === configEntry.sha;

  let config: LogConfig;
  if (configUnchanged && known !== null) {
    config = {
      id: known.publicId,
      product: known.product,
      view: known.view as LogConfig['view'],
      visibility: known.visibility as LogConfig['visibility'],
      curation_notes: known.curationNotes,
    };
  } else {
    const configBytes = await gh.blob(ref, configEntry.sha);
    let parsedConfig;
    try {
      parsedConfig = parseConfig(JSON.parse((configBytes ?? Buffer.alloc(0)).toString('utf8')));
    } catch (err) {
      parsedConfig = { ok: false as const, errors: [(err as Error).message] };
    }
    if (!parsedConfig.ok) {
      writeProblem(db, repoPath, `invalid ${CONFIG_PATH}: ${parsedConfig.errors.join('; ')}`);
      return { logId: null, fetched: 0, errors: 0, frozen: false };
    }
    config = parsedConfig.value;
  }

  // A duplicate id: another repository already registered config.id.
  // First claimant wins — this sync must not touch that repo's log or
  // releases, only record the collision (spec: problem table comment).
  const claimant = db.select().from(log).where(eq(log.publicId, config.id)).all()[0];
  if (claimant && (claimant.repoOwner !== ref.owner || claimant.repoName !== ref.repo)) {
    const claimantPath = `${claimant.repoOwner}/${claimant.repoName}`;
    writeProblem(
      db,
      repoPath,
      `duplicate id ${config.id}: already held by ${claimantPath}, also claimed by ${repoPath}`,
    );
    return { logId: null, fetched: 0, errors: 0, frozen: false };
  }

  // The repo parses, so any earlier complaint about it is stale.
  db.delete(problem).where(eq(problem.path, repoPath)).run();

  // This repository held a different id before (its release-log.json's id
  // field was edited). The upsert below only ever touches config.id, so
  // without this the old id's log and its releases/media/errors would sit
  // in the index forever, orphaned but still served — the unique index
  // on (repo_owner, repo_name) exists so this repo can only ever hold one
  // log, and this is the code side of that same invariant (spec §4).
  if (known !== null && known.publicId !== config.id) {
    const oldId = known.publicId;
    db.delete(release).where(eq(release.logId, oldId)).run();
    db.delete(media).where(eq(media.logId, oldId)).run();
    db.delete(syncError).where(eq(syncError.logId, oldId)).run();
    db.delete(log).where(eq(log.publicId, oldId)).run();
  }

  // head_sha and indexed_at are deliberately not written here — see the
  // update after the release and media sweeps below.
  db.insert(log).values({
    publicId: config.id,
    repoOwner: ref.owner,
    repoName: ref.repo,
    repoNodeId: null,
    product: config.product,
    view: config.view,
    visibility: config.visibility,
    curationNotes: config.curation_notes,
    state: 'active',
    configBlobSha: configEntry.sha,
  }).onConflictDoUpdate({
    target: log.publicId,
    set: {
      repoOwner: ref.owner,
      repoName: ref.repo,
      product: config.product,
      view: config.view,
      visibility: config.visibility,
      curationNotes: config.curation_notes,
      state: 'active',
      configBlobSha: configEntry.sha,
    },
  }).run();

  let fetched = 0;
  let errors = 0;
  const seen = new Set<string>();

  for (const entry of releasePaths(tree)) {
    seen.add(entry.path);
    const name = entry.path.slice('releases/'.length);

    const indexed = db.select().from(release)
      .where(and(eq(release.logId, config.id), eq(release.path, entry.path))).all()[0] ?? null;
    const failed = db.select().from(syncError)
      .where(and(eq(syncError.logId, config.id), eq(syncError.path, entry.path))).all()[0] ?? null;

    // The blob sha is git's own content hash, so an unchanged sha means an
    // unchanged file — for a good release and for a broken one alike. Both
    // states are already recorded; skip the fetch.
    if (indexed?.blobSha === entry.sha) continue;
    if (failed !== null && indexed === null && failed.message.startsWith('sha:' + entry.sha)) {
      // The file is still the same known-broken blob. No fetch, but it is
      // still an error outstanding against this sync (spec: SyncOutcome.errors
      // must reflect every error row, not just the ones re-checked this run).
      errors += 1;
      continue;
    }

    const bytes = await gh.blob(ref, entry.sha);
    fetched += 1;
    if (bytes === null) {
      // A file that used to parse and now doesn't must not go on serving
      // its stale release row forever — drop it before recording the error.
      db.delete(release).where(and(eq(release.logId, config.id), eq(release.path, entry.path))).run();
      const message = `sha:${entry.sha} blob not found`;
      writeSyncError(db, config.id, entry.path, message);
      errors += 1;
      continue;
    }
    let parsed;
    try {
      parsed = parseRelease(JSON.parse(bytes.toString('utf8')), name);
    } catch (err) {
      parsed = { ok: false as const, errors: [(err as Error).message] };
    }
    if (!parsed.ok) {
      // A hand edit must never take the whole log down (spec §10). But it
      // must also not keep serving the old, now-stale content forever —
      // the design is "an error row and no release row" for a broken path.
      db.delete(release).where(and(eq(release.logId, config.id), eq(release.path, entry.path))).run();
      const message = `sha:${entry.sha} ${parsed.errors.join('; ')}`;
      writeSyncError(db, config.id, entry.path, message);
      errors += 1;
      continue;
    }
    const doc = parsed.value;
    db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, entry.path))).run();
    db.insert(release).values({
      logId: config.id,
      version: doc.version,
      date: doc.date,
      publishedAt: doc.published_at,
      blobSha: entry.sha,
      path: entry.path,
      doc: JSON.stringify(doc),
    }).onConflictDoUpdate({
      target: [release.logId, release.version],
      set: { date: doc.date, publishedAt: doc.published_at, blobSha: entry.sha, path: entry.path, doc: JSON.stringify(doc) },
    }).run();
  }

  const seenMedia = new Set<string>();
  for (const entry of mediaPaths(tree)) {
    seenMedia.add(entry.path);
    const type = MEDIA_TYPES[extensionOf(entry.path)];
    if (!type) {
      // A file that used to be a supported type and changed into something
      // else must not keep serving its stale bytes forever.
      db.delete(media).where(and(eq(media.logId, config.id), eq(media.path, entry.path))).run();
      writeSyncError(db, config.id, entry.path, `sha:${entry.sha} unsupported media type`);
      errors += 1;
      continue;
    }
    // The tree carries the size, so an oversized file is rejected without
    // ever being downloaded — and if it used to be indexed and grew past
    // the cap, its stale bytes are dropped too.
    if (entry.size > MEDIA_MAX_BYTES) {
      db.delete(media).where(and(eq(media.logId, config.id), eq(media.path, entry.path))).run();
      writeSyncError(db, config.id, entry.path, `sha:${entry.sha} media file exceeds the 10 MB limit (${entry.size} bytes)`);
      errors += 1;
      continue;
    }
    const indexedMedia = db.select().from(media)
      .where(and(eq(media.logId, config.id), eq(media.path, entry.path))).all()[0] ?? null;
    if (indexedMedia?.blobSha === entry.sha) continue;

    const bytes = await gh.blob(ref, entry.sha);
    fetched += 1;
    if (bytes === null) {
      db.delete(media).where(and(eq(media.logId, config.id), eq(media.path, entry.path))).run();
      writeSyncError(db, config.id, entry.path, `sha:${entry.sha} blob not found`);
      errors += 1;
      continue;
    }
    db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, entry.path))).run();
    db.insert(media).values({
      logId: config.id, path: entry.path, blobSha: entry.sha, contentType: type, bytes,
    }).onConflictDoUpdate({
      target: [media.logId, media.path],
      set: { blobSha: entry.sha, contentType: type, bytes },
    }).run();
  }

  // Only the path is needed to diff against `seenMedia` — selecting the
  // full row would drag every stored blob (up to 10 MB each) into memory
  // just to compare strings.
  for (const row of db.select({ path: media.path }).from(media).where(eq(media.logId, config.id)).all()) {
    if (!seenMedia.has(row.path)) {
      db.delete(media).where(and(eq(media.logId, config.id), eq(media.path, row.path))).run();
    }
  }

  // Anything the tree no longer carries is gone from the index too. Same
  // reasoning as above: pull only what the diff and the delete need, not
  // every release's full `doc`.
  for (const row of db.select({ path: release.path, version: release.version })
    .from(release).where(eq(release.logId, config.id)).all()) {
    if (!seen.has(row.path)) {
      db.delete(release).where(and(eq(release.logId, config.id), eq(release.version, row.version))).run();
    }
  }
  for (const row of db.select().from(syncError).where(eq(syncError.logId, config.id)).all()) {
    if (!seen.has(row.path) && !seenMedia.has(row.path)) {
      db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, row.path))).run();
    }
  }

  // head_sha must not name a commit until the content it names has fully
  // landed: a crash or a thrown error partway through the loops above must
  // leave the previous head_sha in place, not claim the new one over
  // incomplete content (spec: the ETag derived from head_sha must never
  // point at a partial sync).
  db.update(log).set({ headSha: head, indexedAt: now() }).where(eq(log.publicId, config.id)).run();

  return { logId: config.id, fetched, errors, frozen: false };
}
