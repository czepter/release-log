// Webhook und Reconcile stoßen beide denselben Abgleich an, und ein Push-
// Sturm stößt ihn zehnmal in einer Sekunde an. syncLog schreibt in dieselben
// Zeilen und macht am Ende Sweeps über alles, was der Baum nicht mehr trägt
// — zwei Läufe nebeneinander würden sich diese Sweeps gegenseitig unter den
// Füßen wegziehen. Also: einer nach dem anderen, und mehrfach angestoßene
// Repos genau einmal nach.

import type { RepoRef } from './github.ts';

export type Queue = {
  enqueue(ref: RepoRef): void;
  // Läuft, bis nichts mehr wartet. Für Tests und für ein sauberes
  // Herunterfahren; im Betrieb wartet niemand darauf.
  idle(): Promise<void>;
  pending(): number;
};

export function syncQueue(
  run: (ref: RepoRef) => Promise<void>,
  onError: (ref: RepoRef, err: unknown) => void = () => {},
): Queue {
  // Nach Pfad gekeyt, nicht nach Objekt: derselbe Log, zehnmal angestoßen,
  // ist ein Eintrag. Ein Anstoß während des Laufs legt den Eintrag neu an,
  // also folgt genau ein weiterer Lauf.
  const waiting = new Map<string, RepoRef>();
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    for (;;) {
      const next = waiting.entries().next();
      if (next.done) break;
      const [key, ref] = next.value;
      waiting.delete(key);
      try {
        await run(ref);
      } catch (err) {
        // Ein Repo, dessen Abgleich scheitert, darf die anderen nicht
        // mitnehmen — dieselbe Regel wie in reindex().
        onError(ref, err);
      }
    }
    draining = null;
  }

  return {
    enqueue(ref) {
      waiting.set(`${ref.owner}/${ref.repo}`, ref);
      // Deferred by a microtask, not called inline: a push storm calls
      // enqueue() several times in the same synchronous tick, and if drain()
      // started right here, a run with no await of its own (rare, but the
      // test suite has one) would finish inside this very call — so the next
      // enqueue() in the batch would see empty state and start a second run
      // for what was actually one push storm.
      if (draining === null) draining = Promise.resolve().then(drain);
    },
    async idle() {
      while (draining !== null) await draining;
    },
    pending() {
      return waiting.size;
    },
  };
}
