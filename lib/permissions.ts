// Repo-Rechte werden gegen GitHub geprüft, nie lokal erfunden (spec §5,
// Entscheidung 14): das Repo ist die Wahrheit, also sind es auch seine
// Rechte. Die Prüfung kostet einen Netzwerk-Umlauf, deshalb liegt die
// Antwort fünf Minuten je (Konto, Log) im Cache und wird früher
// invalidiert, wenn die zwei Ereignisse eintreffen, die sie veralten
// lassen können (spec §5) -- siehe lib/webhook.ts.

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, repoPermission } from './db/schema.ts';
import type { GitHub, RepoRef } from './github.ts';

const CACHE_MS = 5 * 60 * 1000;

export type Permissions = {
  canWrite(accountId: number, login: string, logId: string, ref: RepoRef): Promise<boolean>;
  invalidate(ref: RepoRef): void;
};

export function permissions(db: Db, gh: GitHub, nowMs: () => number = Date.now): Permissions {
  return {
    async canWrite(accountId, login, logId, ref) {
      const cached = db.select().from(repoPermission)
        .where(and(eq(repoPermission.accountId, accountId), eq(repoPermission.logId, logId))).all()[0];
      if (cached && nowMs() - Date.parse(cached.checkedAt) < CACHE_MS) {
        return cached.canWrite;
      }
      const level = await gh.collaboratorPermission(ref, login);
      const canWrite = level === 'admin' || level === 'write';
      // checkedAt must be stamped from the same clock canWrite compares
      // against (nowMs), not the wall clock: a caller that injects a fake
      // clock to test the five-minute boundary would otherwise compare an
      // injected "now" against a real-time timestamp and the cache would
      // never appear to expire.
      const checkedAt = new Date(nowMs()).toISOString();
      db.insert(repoPermission).values({ accountId, logId, canWrite, checkedAt })
        .onConflictDoUpdate({
          target: [repoPermission.accountId, repoPermission.logId],
          set: { canWrite, checkedAt },
        })
        .run();
      return canWrite;
    },

    invalidate(ref) {
      const row = db.select().from(log)
        .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all()[0];
      if (!row) return;
      // Grob mit Absicht: jede gecachte Zeile dieses Logs, nicht nur ein
      // Konto. Eine Mitgliedschaftsänderung kann mehr betreffen als die
      // eine Person, die das Ereignis zufällig nennt, und ein erneuter
      // Check kostet höchstens eine Anfrage je Konto beim nächsten
      // Gebrauch -- billig gegen das Risiko, ein veraltetes "ja" auszuliefern.
      db.delete(repoPermission).where(eq(repoPermission.logId, row.publicId)).run();
    },
  };
}
