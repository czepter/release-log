// Was GitHub schickt, ist Eingabe und keine Zusicherung. Deshalb zwei
// getrennte reine Funktionen: erst prüfen, ob die Zustellung echt ist,
// dann herausfinden, welche Repositories sie betrifft. Der Server setzt
// beides zusammen und stößt den Abgleich an — hier gibt es kein Netz,
// keine Datenbank und keine Uhr (Spec §9, §10).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RepoRef } from './github.ts';

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  // Dies ist ein Early-Out, keine Sicherheitsprüfung: es erspart das HMAC
  // über den Body, wenn der Header offensichtlich nicht unserer ist. Was den
  // Vergleich sicher macht, ist unten der Vergleich gegen die volle
  // 'sha256=<hex>'-Zeichenkette — ein Header ohne dieses Präfix scheitert
  // dort ohnehin, mit oder ohne diese Zeile.
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'utf8');
  const given = Buffer.from(header, 'utf8');
  // timingSafeEqual wirft bei ungleicher Länge, und die Länge ist ohnehin
  // öffentlich — sie zu vergleichen verrät nichts, was der Angreifer nicht
  // selbst ausrechnen kann.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export type Delivery = { event: string; payload: unknown };

// owner und repo werden später roh in einen GitHub-API-Pfad interpoliert
// (Task 7). Die Frage ist also nicht "sieht das gefährlich aus?" — das lässt
// sich nicht vollständig aufzählen (%2e%2e wird von new URL()/fetch() als
// Punkt-Segment behandelt, ein '?' startet eine Query-String, ein Leerzeichen
// ist ungültig in einer URL) — sondern "kann GitHub ein Repository überhaupt
// so nennen?". Eine Positivliste dessen, was GitHub zulässt, ist die Prüfung,
// keine Negativliste dessen, was verdächtig aussieht.
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function refOf(value: unknown): RepoRef | null {
  const fullName = (value as { full_name?: unknown } | null)?.full_name;
  if (typeof fullName !== 'string') return null;
  const parts = fullName.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  // Das Repo-Zeichenset allein ließe '.' und '..' durch (beides gültige
  // Zeichen), und GitHub würde daraus nie ein Repository machen.
  if (repo === '.' || repo === '..') return null;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  return { owner, repo };
}

function listOf(value: unknown): RepoRef[] {
  if (!Array.isArray(value)) return [];
  return value.map(refOf).filter((ref): ref is RepoRef => ref !== null);
}

export function refsFor(delivery: Delivery): RepoRef[] {
  const payload = (delivery.payload ?? {}) as Record<string, unknown>;
  if (typeof payload !== 'object') return [];

  switch (delivery.event) {
    // Beide tragen genau ein Repository. 'repository' umfasst auch
    // 'deleted' und 'transferred': gerade die müssen angestoßen werden,
    // damit der Abgleich den neuen Zustand sieht (Spec §10).
    case 'push':
    case 'repository': {
      const ref = refOf(payload.repository);
      return ref ? [ref] : [];
    }
    case 'installation':
      return listOf(payload.repositories);
    case 'installation_repositories':
      return [...listOf(payload.repositories_added), ...listOf(payload.repositories_removed)];
    // Alles andere, 'ping' eingeschlossen, ist nichts, wofür der Index
    // sich ändern müsste. Ein unbekanntes Ereignis stößt keinen Abgleich
    // an, statt vorsichtshalber alles anzufassen.
    default:
      return [];
  }
}
