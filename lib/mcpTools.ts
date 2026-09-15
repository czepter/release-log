// Die MCP-Werkzeugfläche (spec §6). Jeder Aufruf löst sein Bearer-Token
// noch einmal gegen die Datenbank auf (lookupAccessToken lief schon einmal
// in der HTTP-Bearer-Prüfung, server.ts Task 12) -- das ist ein billiger,
// indizierter SQLite-Read, keine zweite teure Prüfung, und hält jedes
// Werkzeug unabhängig vom genauen Transport-Verdrahtungscode.
import * as z from 'zod/v4';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { eq, and } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release as releaseTable } from './db/schema.ts';
import type { Reader } from './store.ts';
import type { Permissions } from './permissions.ts';
import { sortReleases, latestOf } from './order.ts';
import { lookupAccessToken } from './oauth.ts';

type CallToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function toolOk(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(error: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message }) }], isError: true };
}

export function buildMcpServer(db: Db, reader: Reader, perms: Permissions): McpServerFactory {
  return async (ctx) => {
    const server = new McpServer({ name: 'release-log-hub', version: '1.0.0' });
    const rawToken = ctx.authInfo?.token;
    const who = rawToken ? lookupAccessToken(db, rawToken) : null;
    const scopes = ctx.authInfo?.scopes ?? [];

    // Erreichbarkeit: öffentlich ODER Schreibrecht (dieselbe Regel wie die
    // gehostete Seite, Task 15, spec §7). Ein privater, nicht erreichbarer
    // Log sieht aus wie ein nicht existierender -- nie ein Fehlercode, der
    // seine Existenz verrät.
    async function reach(logId: string): Promise<{ row: typeof log.$inferSelect; canWriteThis: boolean } | null> {
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      if (!row) return null;
      const ref = { owner: row.repoOwner, repo: row.repoName };
      const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
      if (row.visibility !== 'public' && !canWriteThis) return null;
      return { row, canWriteThis };
    }

    server.registerTool(
      'list_logs',
      { description: 'Logs, die dieser Zugang lesen kann: ID, Repo, Produkt, letzte Version.', inputSchema: z.object({}) },
      async () => {
        if (!scopes.includes('logs:read')) return toolError('forbidden', 'logs:read scope required');
        const allLogs = db.select().from(log).all();
        const entries: Array<{ id: string; repo: string; product: string; latest_version: string | null }> = [];
        for (const row of allLogs) {
          const ref = { owner: row.repoOwner, repo: row.repoName };
          const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
          if (row.visibility !== 'public' && !canWriteThis) continue;
          const releases = reader.releases(row.publicId);
          const latest = canWriteThis ? sortReleases(releases)[0] ?? null : latestOf(releases);
          entries.push({ id: row.publicId, repo: `${row.repoOwner}/${row.repoName}`, product: row.product, latest_version: latest?.version ?? null });
        }
        return toolOk({ logs: entries });
      },
    );

    server.registerTool(
      'get_log',
      { description: 'Konfiguration, alle Versionen mit Stand, und covered der jüngsten Version.', inputSchema: z.object({ log_id: z.string() }) },
      async ({ log_id }) => {
        if (!scopes.includes('logs:read')) return toolError('forbidden', 'logs:read scope required');
        const reached = await reach(log_id);
        if (!reached) return toolError('not_found', `no such log: ${log_id}`);
        const config = reader.config(log_id);
        if (!config) return toolError('not_found', `no such log: ${log_id}`);
        const allReleases = reader.releases(log_id);
        const visibleReleases = reached.canWriteThis ? allReleases : allReleases.filter((r) => r.published_at !== null);
        const sorted = sortReleases(visibleReleases);
        return toolOk({
          id: config.id, product: config.product, view: config.view, visibility: config.visibility,
          curation_notes: config.curation_notes,
          versions: sorted.map((r) => ({ version: r.version, date: r.date, published_at: r.published_at })),
          covered: sorted[0]?.covered ?? [],
        });
      },
    );

    server.registerTool(
      'get_release',
      { description: 'Ganzes Dokument einer Version plus blob_sha.', inputSchema: z.object({ log_id: z.string(), version: z.string() }) },
      async ({ log_id, version }) => {
        if (!scopes.includes('logs:read')) return toolError('forbidden', 'logs:read scope required');
        const reached = await reach(log_id);
        if (!reached) return toolError('not_found', `no such log: ${log_id}`);
        const row = db.select().from(releaseTable)
          .where(and(eq(releaseTable.logId, log_id), eq(releaseTable.version, version))).all()[0];
        if (!row) return toolError('not_found', `no such version: ${version}`);
        const doc = JSON.parse(row.doc);
        if (doc.published_at === null && !reached.canWriteThis) return toolError('not_found', `no such version: ${version}`);
        return toolOk({ ...doc, blob_sha: row.blobSha });
      },
    );

    return server;
  };
}
