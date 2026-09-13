// Der Webhook sorgt für Sofortigkeit, dieses Intervall dafür, dass ein
// verlorener Webhook höchstens eine Runde kostet statt für immer zu driften
// (Spec §4). Der Zustandsvergleich in syncLog braucht keine lückenlose
// Zustellung, nur irgendwann einen Anstoß — das hier ist das "irgendwann".

import { asc } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log } from './db/schema.ts';
import type { RepoRef } from './github.ts';
import type { Queue } from './syncQueue.ts';

// Exported so a test can pin the actual values (README documents them as
// 5 minutes and 1 hour) — every other test passes an explicit
// everyMs/nowMs instead of exercising these constants, so nothing else
// would catch a silent drift here.
export const STALE_MS = 60 * 60 * 1000;
export const EVERY_MS = 5 * 60 * 1000;

export function dueLogs(db: Db, nowMs: number): RepoRef[] {
  // Nach indexed_at aufsteigend, NULL zuerst — ein nie erfasster Log ist
  // der älteste, den es gibt. SQLite sortiert NULL von sich aus nach vorn.
  const rows = db.select({ owner: log.repoOwner, repo: log.repoName, indexedAt: log.indexedAt })
    .from(log).orderBy(asc(log.indexedAt)).all();
  if (rows.length === 0) return [];

  const due: RepoRef[] = [];
  const seen = new Set<string>();
  const take = (row: { owner: string; repo: string }): void => {
    const key = `${row.owner}/${row.repo}`;
    if (seen.has(key)) return;
    seen.add(key);
    due.push({ owner: row.owner, repo: row.repo });
  };

  // Regel 1: der älteste, immer. Sonst täte eine Runde in einem ruhigen
  // Bestand gar nichts.
  take(rows[0]);
  // Regel 2: alles, was über eine Stunde nicht erfasst wurde. Das ist die
  // Zusage "jeder Log mindestens stündlich", die Regel 1 allein bei mehr
  // als zwölf Logs nicht mehr halten könnte.
  for (const row of rows) {
    if (row.indexedAt === null || nowMs - Date.parse(row.indexedAt) > STALE_MS) take(row);
  }

  // Eingefrorene Logs sind absichtlich nicht gefiltert: sie kosten einen
  // einzigen probe-Aufruf, und nur so kann Spec §10s "der nächste
  // erfolgreiche Abgleich taut den Log von selbst auf" je eintreten.
  return due;
}

export function reconcileTick(db: Db, queue: Queue, nowMs: number): number {
  const due = dueLogs(db, nowMs);
  for (const ref of due) queue.enqueue(ref);
  return due.length;
}

export function startReconcile(db: Db, queue: Queue, everyMs: number = EVERY_MS): { stop(): void } {
  const timer = setInterval(() => { reconcileTick(db, queue, Date.now()); }, everyMs);
  // Ein Intervall darf den Prozess nicht am Leben halten, wenn sonst nichts
  // mehr läuft.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
