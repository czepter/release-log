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
import { parseRelease } from './document.ts';
import type { GitHub, RepoRef } from './github.ts';

type CallToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function toolOk(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(error: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message }) }], isError: true };
}

export type McpToolDeps = {
  db: Db; reader: Reader; perms: Permissions; gh: GitHub; onRepoWrite: (ref: RepoRef) => void; baseUrl: string;
};

// Der Kurationsteil des Vorbild-Skills, wörtlich aus spec §6.
const INSTRUCTIONS = `
Rohstoff ist nie Ergebnis. Ein Release ist fertig, wenn kein Eintrag mehr wie eine Commit-Nachricht liest.
Ein Eintrag ist ein Thema, kein Commit. 15 Commits werden zu drei bis fünf Themen.
Der Lesertest: ein Satz bleibt, wenn der Leser das auf seinem Bildschirm bemerken kann. Klassennamen, Tabellen, Spalten, Framework- und Paketnamen fallen raus; sichtbar gewordene technische Aussagen bleiben.
title ist ein Substantivstück, kein Imperativ, keine Route, kein Ticketkürzel. description sind mehrere Absätze: was jetzt geht, warum es so entschieden wurde, was nebenbei behoben wurde.
headline benennt, sie bewertet nicht. body nennt Richtungen des Release, statt die Einträge nachzuerzählen.
Typen: feat -> Neu, perf -> Änderungen, fix -> Behoben.
breaking: true setzen, wenn der Leser handeln muss. Die Handlungsanweisung gehört in description.
covered nie von Hand anfassen.

Ablauf:
1. list_logs, dann get_log -- liefert jüngste Version und deren covered.
2. Lies lokal "git log" ab diesen Commits.
3. Verwandte Commits zu Themen bündeln, Prosa schreiben.
4. write_release mit published_at: null -- ein Entwurf.
5. Der Mensch liest den Permalink, den der Aufruf zurückgibt.
6. publish_release.
`.trim();

export function buildMcpServer(deps: McpToolDeps): McpServerFactory {
  const { db, reader, perms, gh, onRepoWrite, baseUrl } = deps;
  return async (ctx) => {
    const server = new McpServer(
      { name: 'release-log-hub', version: '1.0.0' },
      { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
    );
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

    server.registerTool(
      'write_release',
      {
        description: 'Legt eine Version an oder ersetzt sie, committet ins Repo.',
        inputSchema: z.object({
          log_id: z.string(), version: z.string(),
          document: z.record(z.string(), z.unknown()),
          base_blob_sha: z.string().nullable().optional(),
        }),
      },
      async ({ log_id, version, document, base_blob_sha }) => {
        if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
        const row = db.select().from(log).where(eq(log.publicId, log_id)).all()[0];
        if (!row) return toolError('not_found', `no such log: ${log_id}`);
        // Frozen ist unconditional (kein Admin-Ausnahmefall wie im
        // Dashboard, s. Task-16-Kontext): das Repo ist unerreichbar, also
        // wird nicht erst ein GitHub-Aufruf riskiert, um Schreibrecht zu
        // prüfen, der ohnehin nur scheitern kann.
        if (row.state === 'frozen') return toolError('log_frozen', 'this log is frozen; its repository is unreachable');
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!canWriteThis) return toolError('forbidden', 'no write access to this repository');

        const parsed = parseRelease(document, `${version}.json`);
        if (!parsed.ok) return toolError('invalid_document', parsed.errors.join('; '));

        const existing = db.select().from(releaseTable)
          .where(and(eq(releaseTable.logId, log_id), eq(releaseTable.version, version))).all()[0];
        // Blindes Überschreiben ist ausgeschlossen (spec §6): existiert die
        // Version schon UND wurde keine base_blob_sha mitgegeben, ist das
        // ein Konflikt, ohne dass überhaupt ein Netzwerk-Aufruf stattfindet.
        if (existing && !base_blob_sha) {
          return toolError('conflict', JSON.stringify({ current_blob_sha: existing.blobSha, current_document: JSON.parse(existing.doc) }));
        }

        const path = `releases/${version}.json`;
        const content = Buffer.from(JSON.stringify(parsed.value, null, 2), 'utf8');
        const result = await gh.putFile(ref, path, content, `write release ${version} via MCP`, base_blob_sha ?? null);
        if (result.kind === 'no_installation') {
          return toolError('no_installation', 'the GitHub App is not installed on this repository');
        }
        if (result.kind === 'conflict') {
          const fresh = db.select().from(releaseTable)
            .where(and(eq(releaseTable.logId, log_id), eq(releaseTable.version, version))).all()[0];
          return toolError('conflict', JSON.stringify({
            current_blob_sha: fresh?.blobSha ?? null, current_document: fresh ? JSON.parse(fresh.doc) : null,
          }));
        }
        onRepoWrite(ref);
        return toolOk({ commit_sha: result.sha, permalink: `${baseUrl}/l/${log_id}/r/${encodeURIComponent(version)}` });
      },
    );

    // publish_release/unpublish_release teilen sich diese Mechanik: die
    // bestehende Version existiert per Definition schon, also gibt es hier
    // (anders als bei write_release) kein base_blob_sha-Konzept -- die
    // aktuell bekannte blobSha ist immer die expectedSha.
    async function togglePublish(logId: string, version: string, publishedAt: string | null): Promise<CallToolResult> {
      if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      if (!row) return toolError('not_found', `no such log: ${logId}`);
      // Frozen ist unconditional (wie write_release, Task 16): das Repo ist
      // unerreichbar, also wird nicht erst ein GitHub-Aufruf riskiert, um
      // Schreibrecht zu prüfen, der ohnehin nur scheitern kann.
      if (row.state === 'frozen') return toolError('log_frozen', 'this log is frozen; its repository is unreachable');
      const ref = { owner: row.repoOwner, repo: row.repoName };
      const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
      if (!canWriteThis) return toolError('forbidden', 'no write access to this repository');

      const existing = db.select().from(releaseTable)
        .where(and(eq(releaseTable.logId, logId), eq(releaseTable.version, version))).all()[0];
      if (!existing) return toolError('not_found', `no such version: ${version}`);

      const doc = { ...JSON.parse(existing.doc), published_at: publishedAt };
      const path = `releases/${version}.json`;
      const content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
      const message = `${publishedAt !== null ? 'publish' : 'unpublish'} release ${version} via MCP`;
      const result = await gh.putFile(ref, path, content, message, existing.blobSha);
      if (result.kind === 'no_installation') return toolError('no_installation', 'the GitHub App is not installed on this repository');
      if (result.kind === 'conflict') {
        return toolError('conflict', 'the release changed since it was last read; call get_release and try again');
      }
      onRepoWrite(ref);
      return toolOk({ commit_sha: result.sha, permalink: `${baseUrl}/l/${logId}/r/${encodeURIComponent(version)}` });
    }

    server.registerTool(
      'publish_release',
      { description: 'Setzt published_at auf jetzt.', inputSchema: z.object({ log_id: z.string(), version: z.string() }) },
      ({ log_id, version }) => togglePublish(log_id, version, new Date().toISOString()),
    );

    server.registerTool(
      'unpublish_release',
      { description: 'Setzt published_at auf null.', inputSchema: z.object({ log_id: z.string(), version: z.string() }) },
      ({ log_id, version }) => togglePublish(log_id, version, null),
    );

    server.registerPrompt(
      'release-kuratieren',
      { title: 'Release kuratieren', description: 'Stößt den Kurationsablauf für ein Log an.', argsSchema: z.object({ log_id: z.string().optional() }) },
      ({ log_id }) => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: log_id
              ? `Kuratiere das nächste Release für Log ${log_id}. Beginne mit get_log.`
              : 'Kuratiere das nächste Release. Beginne mit list_logs, um die verfügbaren Logs zu sehen.',
          },
        }],
      }),
    );

    return server;
  };
}
