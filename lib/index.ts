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
    db.insert(problem)
      .values({ path: repoPath, message: `no ${CONFIG_PATH} in ${repoPath}`, at: now() })
      .onConflictDoUpdate({ target: problem.path, set: { message: `no ${CONFIG_PATH} in ${repoPath}`, at: now() } })
      .run();
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
    const message = `invalid ${CONFIG_PATH}: ${parsedConfig.errors.join('; ')}`;
    db.insert(problem)
      .values({ path: repoPath, message, at: now() })
      .onConflictDoUpdate({ target: problem.path, set: { message, at: now() } })
      .run();
    return { logId: null, fetched: 0, errors: 0, frozen: false };
  }
  const config = parsedConfig.value;

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
      db.insert(syncError).values({ logId: config.id, path: entry.path, message: 'blob not found', at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message: 'blob not found', at: now() } }).run();
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
      const message = parsed.errors.join('; ');
      db.insert(syncError).values({ logId: config.id, path: entry.path, message, at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message, at: now() } }).run();
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
