// Die Verdrahtung eines laufenden Diensts: Datenbank, GitHub, Abgleich-
// Warteschlange, Reconcile, Rechte, Nutzer-Token. Früher stand sie in
// server.ts unter import.meta.main; seit Nuxt den Kern einbettet
// (Entscheidung 24), brauchen zwei Einstiegspunkte dieselben Teile.
// createHandler kommt NICHT von hier -- server.ts importiert diese Datei,
// ein Rückimport wäre ein Zyklus.

import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { readConfig } from './config.ts';
import { installations } from './appAuth.ts';
import { githubClient, userRepoCreator } from './github.ts';
import { withRetry } from './http.ts';
import type { Http } from './http.ts';
import { syncQueue } from './syncQueue.ts';
import { syncLog } from './index.ts';
import { startReconcile } from './reconcile.ts';
import { permissions } from './permissions.ts';
import { userTokens } from './userTokens.ts';
import { cipher } from './secrets.ts';
import { indexReader } from './indexReader.ts';
import type { Reader } from './store.ts';
import type { Hooks, Auth } from '../server.ts';

export type Core = { reader: Reader; hooks: Hooks; auth: Auth; db: Db; dbPath: string };

export function bootCore(env: NodeJS.ProcessEnv, opts: { migrationsFolder?: string } = {}): Core {
  const dbPath = env.DB_PATH ?? './release-log.sqlite';
  const db = opts.migrationsFolder ? openDb(dbPath, opts.migrationsFolder) : openDb(dbPath);

  const config = readConfig(env);
  // Node has no default fetch timeout: a hung connection would block this
  // process's single in-flight sync indefinitely, stalling every
  // repository's sync, not just the hung one. 30s is generous for a
  // single GitHub API call, including the blobs a sync fetches one at a
  // time. Same treatment as bin/reindex.ts, for the same reason.
  const FETCH_TIMEOUT_MS = 30_000;
  const gh = githubClient(
    installations(config, withRetry((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }))),
    withRetry((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })),
  );
  const queue = syncQueue(
    async (ref) => { await syncLog(db, gh, ref); },
    (ref, err) => { console.error(`${ref.owner}/${ref.repo}: ${(err as Error).message}`); },
  );
  startReconcile(db, queue);

  const perms = permissions(db, gh);
  const authHttp: Http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const users = userTokens({
    db, http: authHttp, cipher: cipher(config.tokenEncryptionKey),
    clientId: config.clientId, clientSecret: config.clientSecret,
  });

  return {
    db,
    dbPath,
    reader: indexReader(db),
    hooks: {
      webhookSecret: config.webhookSecret,
      onDelivery: (refs) => { for (const ref of refs) queue.enqueue(ref); },
      onPermissionInvalidation: (refs) => { for (const ref of refs) perms.invalidate(ref); },
    },
    auth: {
      db,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      signingKey: config.signingKey,
      adminLogins: config.adminLogins,
      baseUrl: config.baseUrl,
      http: authHttp,
      gh,
      perms,
      users,
      // Ohne withRetry, anders als jeder andere GitHub-Aufruf hier: ein
      // Wiederholungsversuch auf POST /user/repos kann ein zweites Repo
      // anlegen (oder das erste als „Name vergeben" zurückmelden), wenn die
      // erste Antwort unterwegs verloren ging. Anlegen ist nicht idempotent.
      createRepo: userRepoCreator(authHttp),
      onRepoWrite: (ref) => { queue.enqueue(ref); },
      // Durch dieselbe Warteschlange wie jeder andere Abgleich, nur
      // abgewartet: zwei Läufe auf demselben Repo würden einander die Sweeps
      // unter den Füßen wegziehen (s. lib/syncQueue.ts).
      syncNow: async (ref) => { queue.enqueue(ref); await queue.idle(); },
    },
  };
}
