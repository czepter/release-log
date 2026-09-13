import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncQueue } from './syncQueue.ts';

const REF = { owner: 'o', repo: 'r' };

test('an enqueued ref is run', async () => {
  const seen: string[] = [];
  const q = syncQueue(async (ref) => { seen.push(`${ref.owner}/${ref.repo}`); });
  q.enqueue(REF);
  await q.idle();
  assert.deepEqual(seen, ['o/r']);
});

test('two refs run one after the other, never side by side', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const q = syncQueue(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
  });
  q.enqueue({ owner: 'o', repo: 'a' });
  q.enqueue({ owner: 'o', repo: 'b' });
  await q.idle();
  assert.equal(maxInFlight, 1, 'zwei Läufe auf denselben Zeilen dürfen sich nicht überlappen');
});

test('a ref enqueued twice before it runs runs once', async () => {
  let runs = 0;
  const q = syncQueue(async () => { runs += 1; });
  q.enqueue(REF);
  q.enqueue(REF);
  q.enqueue(REF);
  await q.idle();
  assert.equal(runs, 1, 'drei Pushes in einer Sekunde sind ein Abgleich, nicht drei');
});

test('a ref enqueued while it runs runs exactly once more', async () => {
  // Der Anstoß kam nach dem Lesen des Baums, also muss ein weiterer Lauf
  // folgen — aber genau einer, egal wie oft angestoßen wurde.
  let runs = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const q = syncQueue(async () => {
    runs += 1;
    if (runs === 1) await blocked;
  });
  q.enqueue(REF);
  await new Promise((resolve) => setImmediate(resolve));
  q.enqueue(REF);
  q.enqueue(REF);
  release();
  await q.idle();
  assert.equal(runs, 2);
});

test('a throwing run does not stop the queue', async () => {
  const done: string[] = [];
  const errors: string[] = [];
  const q = syncQueue(
    async (ref) => {
      if (ref.repo === 'bad') throw new Error('500 from upstream');
      done.push(ref.repo);
    },
    (ref, err) => { errors.push(`${ref.repo}: ${(err as Error).message}`); },
  );
  q.enqueue({ owner: 'o', repo: 'bad' });
  q.enqueue({ owner: 'o', repo: 'good' });
  await q.idle();
  assert.deepEqual(done, ['good'], 'ein kaputtes Repo darf die anderen nicht mitnehmen');
  assert.deepEqual(errors, ['bad: 500 from upstream']);
});

test('idle on an empty queue resolves immediately', async () => {
  await syncQueue(async () => {}).idle();
});

test('pending counts what is waiting', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const q = syncQueue(async () => { await blocked; });
  q.enqueue({ owner: 'o', repo: 'a' });
  q.enqueue({ owner: 'o', repo: 'b' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(q.pending(), 1, 'a läuft, b wartet');
  release();
  await q.idle();
  assert.equal(q.pending(), 0);
});
