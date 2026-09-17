// Gemeinsame Test-Verdrahtung für alles, was ein Auth-Objekt braucht
// (lib/access, lib/oauthRequest, lib/api). Nur von *.test.ts importiert.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { account, log } from './db/schema.ts';
import { permissions } from './permissions.ts';
import type { GitHub, RepoRef, CommitResult } from './github.ts';
import { fakeHttp } from './http.ts';
import { userTokens } from './userTokens.ts';
import { cipher } from './secrets.ts';
import { indexReader } from './indexReader.ts';
import type { Reader } from './store.ts';
import { createSessionCookie } from './session.ts';
import type { Auth } from '../server.ts';
import type { LoggedIn } from './access.ts';

export const SIGNING_KEY = 'test-signing-key';

export type Put = { ref: RepoRef; path: string; content: Buffer; expectedSha: string | null };

export type Ctx = {
  auth: Auth; db: Db; reader: Reader;
  puts: Put[]; repoWrites: RepoRef[];
  // Steuert, was GitHub antwortet: Rechte je Repo-Name, Ergebnis von putFile.
  permission: Record<string, 'write' | 'read' | null>;
  commit: CommitResult;
};

export async function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-ctx-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const ctx = { puts: [], repoWrites: [], permission: {}, commit: { kind: 'committed', sha: 'newsha' } } as unknown as Ctx;
  const gh: GitHub = {
    probe: async () => ({ kind: 'ready', head: 'h', nodeId: 'R1' }),
    tree: async () => [],
    blob: async () => null,
    collaboratorPermission: async (ref) => ctx.permission[ref.repo] ?? null,
    async putFile(ref, path, content, _message, expectedSha) {
      ctx.puts.push({ ref, path, content, expectedSha });
      return ctx.commit;
    },
  };
  const http = fakeHttp({});
  ctx.db = db;
  ctx.reader = indexReader(db);
  ctx.auth = {
    db, clientId: 'client-id', clientSecret: 'client-secret', signingKey: SIGNING_KEY,
    adminLogins: ['admin'], openSignup: false, maxLogsPerOwner: 10, baseUrl: 'https://example.test', http, gh, perms: permissions(db, gh),
    users: userTokens({ db, http, cipher: cipher(Buffer.alloc(32, 3)), clientId: 'client-id', clientSecret: 'client-secret' }),
    createRepo: async () => ({ kind: 'unavailable', status: 503 }),
    listRepos: async () => ({ kind: 'ok', repos: [] }),
    onRepoWrite: (ref) => { ctx.repoWrites.push(ref); },
    syncNow: async () => {},
  };
  try {
    await fn(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let nextAccountId = 100;

export function signIn(ctx: Ctx, login: string): { who: LoggedIn; cookie: string } {
  const id = nextAccountId++;
  ctx.db.insert(account).values({ githubUserId: id, login, avatarUrl: null, lastSeenAt: '2026-09-01T00:00:00.000Z' }).run();
  return {
    who: { accountId: id, login, isAdmin: ctx.auth.adminLogins.includes(login) },
    cookie: `session=${createSessionCookie(SIGNING_KEY, id)}`,
  };
}

export function addLog(ctx: Ctx, publicId: string, over: Partial<typeof log.$inferInsert> = {}): void {
  ctx.db.insert(log).values({
    publicId, repoOwner: 'o', repoName: publicId, repoNodeId: `R_${publicId}`, product: `Produkt ${publicId}`,
    view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'h',
    configBlobSha: 'cfgsha', indexedAt: '2026-09-01T00:00:00.000Z', ...over,
  }).run();
}
