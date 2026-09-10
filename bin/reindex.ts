// Rebuilding the index by hand. It is the same syncLog the webhook calls,
// so a rebuild is not a special path — an empty index is simply a tree in
// which everything changed (spec §4).

import { openDb } from '../lib/db/client.ts';
import type { Db } from '../lib/db/client.ts';
import { syncLog } from '../lib/index.ts';
import { githubClient } from '../lib/github.ts';
import type { GitHub, RepoRef } from '../lib/github.ts';
import type { SyncOutcome } from '../lib/index.ts';
import { readConfig } from '../lib/config.ts';
import { installations } from '../lib/appAuth.ts';
import { withRetry } from '../lib/http.ts';
import type { Http } from '../lib/http.ts';

// Assembled here rather than inside githubClient so a test can hand in a
// fake http and a caller can hand in the real fetch.
export function buildClient(env: Record<string, string | undefined>, http: Http): GitHub {
  const config = readConfig(env);
  return githubClient(installations(config, http), http);
}

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
    const [owner, repo, ...rest] = arg.split('/');
    if (!owner || !repo || rest.length > 0) {
      console.error(`not an owner/repo pair: ${arg}`);
      process.exit(1);
    }
    return { owner, repo };
  });
  if (refs.length === 0) {
    console.error('usage: node bin/reindex.ts <owner>/<repo> [...]');
    process.exit(1);
  }

  // Node has no default fetch timeout: a hung connection would hang the
  // CLI forever, and will hang a later plan's reconcile loop the same way.
  // 30s is generous for a single GitHub API call, including the blobs a
  // sync fetches one at a time.
  const FETCH_TIMEOUT_MS = 30_000;
  const gh = buildClient(
    process.env,
    withRetry((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })),
  );
  const outcomes = await reindex(openDb(dbPath), gh, refs);
  for (const [i, outcome] of outcomes.entries()) {
    const ref = refs[i];
    const state = outcome.failed ? 'failed'
      : outcome.frozen ? 'frozen'
      : outcome.logId === null ? 'not a log'
      : `${outcome.logId} (${outcome.fetched} fetched, ${outcome.errors} errors)`;
    console.log(`${ref.owner}/${ref.repo}: ${state}`);
  }
  if (outcomes.some((o) => o.failed)) process.exit(1);
}
