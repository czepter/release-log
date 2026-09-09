// Rebuilding the index by hand. It is the same syncLog the webhook calls,
// so a rebuild is not a special path — an empty index is simply a tree in
// which everything changed (spec §4).

import { openDb } from '../lib/db/client.ts';
import type { Db } from '../lib/db/client.ts';
import { syncLog } from '../lib/index.ts';
import type { GitHub, RepoRef } from '../lib/github.ts';
import type { SyncOutcome } from '../lib/index.ts';

export async function reindex(db: Db, gh: GitHub, refs: RepoRef[]): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  for (const ref of refs) {
    // One repo's failure is not the run's failure: catch it, record it,
    // and keep going with the rest.
    try {
      outcomes.push(await syncLog(db, gh, ref));
    } catch (err) {
      console.error(`reindex: ${ref.owner}/${ref.repo} failed: ${(err as Error).message}`);
      outcomes.push({ logId: null, fetched: 0, errors: 0, frozen: false, failed: true });
    }
  }
  return outcomes;
}

if (import.meta.main) {
  const dbPath = process.env.DB_PATH ?? './release-log.sqlite';
  const refs = process.argv.slice(2).map((arg) => {
    const [owner, repo] = arg.split('/');
    if (!owner || !repo) {
      console.error(`not an owner/repo pair: ${arg}`);
      process.exit(1);
    }
    return { owner, repo };
  });
  if (refs.length === 0) {
    console.error('usage: node bin/reindex.ts <owner>/<repo> [...]');
    process.exit(1);
  }
  // Plan 2 has no real GitHub client yet, so the entrypoint says so rather
  // than pretending. Plan 3 replaces this line with the real one.
  console.error('bin/reindex.ts needs the GitHub client from Plan 3; the reindex() function is usable today.');
  process.exit(1);
}
