// The single place that changes the index. A write path, a webhook and a
// reconcile run all call this one function, so drift between them is not
// possible (spec §4).

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release, syncError, problem } from './db/schema.ts';
import type { GitHub, RepoRef, TreeEntry } from './github.ts';
import { parseConfig, parseRelease } from './document.ts';

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
  const config = parsedConfig.value;

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
    headSha: head,
    configBlobSha: configEntry.sha,
    indexedAt: now(),
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
      headSha: head,
      configBlobSha: configEntry.sha,
      indexedAt: now(),
    },
  }).run();

  let fetched = 0;
  let errors = 0;
  const seen = new Set<string>();

  for (const entry of releasePaths(tree)) {
    seen.add(entry.path);
    const name = entry.path.slice('releases/'.length);
    const bytes = await gh.blob(ref, entry.sha);
    fetched += 1;
    if (bytes === null) {
      writeSyncError(db, config.id, entry.path, 'blob not found');
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
      // A hand edit must never take the whole log down (spec §10).
      writeSyncError(db, config.id, entry.path, parsed.errors.join('; '));
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

  // Anything the tree no longer carries is gone from the index too.
  for (const row of db.select().from(release).where(eq(release.logId, config.id)).all()) {
    if (!seen.has(row.path)) {
      db.delete(release).where(and(eq(release.logId, config.id), eq(release.version, row.version))).run();
    }
  }
  for (const row of db.select().from(syncError).where(eq(syncError.logId, config.id)).all()) {
    if (!seen.has(row.path)) {
      db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, row.path))).run();
    }
  }

  return { logId: config.id, fetched, errors, frozen: false };
}
