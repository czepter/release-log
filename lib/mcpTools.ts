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
import { writeRelease, setPublished } from './releaseWrites.ts';
import type { WriteResult } from './releaseWrites.ts';
import type { GitHub, RepoRef, CreateUserRepo } from './github.ts';
import type { UserTokens } from './userTokens.ts';
import { createLog } from './createLog.ts';
import { mediaTypeOf } from './mediaTypes.ts';
import { MEDIA_MAX_BYTES } from './index.ts';
import { mintUploadToken, normalizeMediaPath } from './uploads.ts';

type CallToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function toolOk(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// Die Fehler von lib/releaseWrites.ts in der Form, die MCP-Clients seit
// jeher bekommen: ein write_release-Konflikt trägt den aktuellen Stand als
// JSON in der Nachricht.
function toToolResult(result: WriteResult): CallToolResult {
  if (result.ok) return toolOk({ commit_sha: result.commitSha, permalink: result.permalink });
  if (result.current) {
    return toolError(result.error, JSON.stringify({ current_blob_sha: result.current.blobSha, current_document: result.current.document }));
  }
  return toolError(result.error, result.message);
}

function toolError(error: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message }) }], isError: true };
}

export type McpToolDeps = {
  db: Db; reader: Reader; perms: Permissions; gh: GitHub; onRepoWrite: (ref: RepoRef) => void; baseUrl: string;
  // Nur create_log braucht diese drei: das Nutzer-Token, mit dem ein Repo
  // überhaupt entstehen kann, der Aufruf, der es anlegt, und der Abgleich,
  // auf den die Antwort warten muss (spec §6, Entscheidung 23).
  users: UserTokens; createRepo: CreateUserRepo; syncNow: (ref: RepoRef) => Promise<void>;
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
1. list_logs, dann get_log -- liefert jüngste Version und deren covered. Gibt es noch keinen Log, legt create_log einen an.
2. Lies lokal "git log" ab diesen Commits.
3. Verwandte Commits zu Themen bündeln, Prosa schreiben.
4. Bilder mit add_media hochladen: das Werkzeug liefert eine Upload-URL, die Bytes gehen per PUT dorthin, und image.src im Dokument ist danach der zurückgegebene Pfad.
5. write_release mit published_at: null -- ein Entwurf.
6. Der Mensch liest den Permalink, den der Aufruf zurückgibt.
7. publish_release.
`.trim();

export function buildMcpServer(deps: McpToolDeps): McpServerFactory {
  const { db, reader, perms, gh, onRepoWrite, baseUrl, users, createRepo, syncNow } = deps;
  return async (ctx) => {
    const server = new McpServer(
      { name: 'release-log-hub', version: '1.0.0' },
      { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
    );
    const rawToken = ctx.authInfo?.token;
    const who = rawToken ? lookupAccessToken(db, rawToken) : null;
    const scopes = ctx.authInfo?.scopes ?? [];
    const writeDeps = { db, perms, gh, onRepoWrite, baseUrl };

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
        return toToolResult(await writeRelease(writeDeps, who, log_id, version, document, base_blob_sha ?? null));
      },
    );

    // publish_release/unpublish_release teilen sich diese Mechanik: die
    // bestehende Version existiert per Definition schon, also gibt es hier
    // (anders als bei write_release) kein base_blob_sha-Konzept -- die
    // aktuell bekannte blobSha ist immer die expectedSha.
    async function togglePublish(logId: string, version: string, publishedAt: string | null): Promise<CallToolResult> {
      if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
      return toToolResult(await setPublished(writeDeps, who, logId, version, publishedAt));
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

    // create_log ist der einzige Aufruf dieses Diensts, der ein
    // GitHub-NUTZER-Token braucht: POST /user/repos gibt es nur dafür
    // (spec §5, Entscheidung 23). Die Reihenfolge -- Repo anlegen,
    // Erreichbarkeit prüfen, Dateien schreiben, indizieren -- steht in
    // lib/createLog.ts, weil der Dashboard-Knopf dieselbe braucht.
    server.registerTool(
      'create_log',
      {
        description: 'Legt ein Repository mit frischer release-log.json an, indiziert es und liefert Kennung und URL.',
        inputSchema: z.object({
          repo_name: z.string(),
          owner: z.string(),
          product: z.string(),
          view: z.enum(['full', 'timeline']).optional(),
          visibility: z.enum(['public', 'private']).optional(),
        }),
      },
      async ({ repo_name, owner, product, view, visibility }) => {
        if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
        // who ist null, wenn das Token zu keinem Konto mehr auflöst. Für
        // jedes andere Werkzeug endet das in canWrite; hier gibt es kein
        // Repo, gegen das man fragen könnte, also steht die Absage hier.
        if (who === null) return toolError('forbidden', 'this token is not bound to an account');
        const result = await createLog({ db, gh, users, createRepo, syncNow, baseUrl }, {
          accountId: who.accountId, login: who.login, owner, repoName: repo_name, product, view, visibility,
        });
        if (!result.ok) return toolError(result.error, result.message);
        return toolOk({
          log_id: result.value.logId,
          url: result.value.url,
          repo: `${result.value.owner}/${result.value.repo}`,
        });
      },
    );

    // add_media stellt nur die Erlaubnis aus; die Bytes gehen per PUT an
    // die Upload-Route (server.ts) und laufen so nie durch den Kontext des
    // Agenten -- 5 MB Bild wären als Base64 rund 6,7 MB Text (spec §6).
    //
    // Zwei Fehlernamen stehen nicht in spec §6's Liste: bad_filename und
    // unsupported_type. Beide gibt es schon, mit genau dieser Bedeutung, im
    // Dashboard-Upload (server.ts) -- ein zweiter Name für dieselbe
    // Ablehnung wäre die schlechtere Wahl als eine Liste, die zwei
    // Eingabefehler des Transports nicht vorhergesehen hat.
    server.registerTool(
      'add_media',
      {
        description: 'Liefert eine einmalige Upload-URL für ein Bild unter media/<Dateiname>. Die Bytes gehen per PUT dorthin, nicht durch dieses Werkzeug.',
        inputSchema: z.object({ log_id: z.string(), path: z.string() }),
      },
      async ({ log_id, path }) => {
        if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
        const row = db.select().from(log).where(eq(log.publicId, log_id)).all()[0];
        if (!row) return toolError('not_found', `no such log: ${log_id}`);
        // Frozen zuerst, wie write_release und togglePublish: das Repo ist
        // unerreichbar, also wird kein GitHub-Aufruf riskiert, der ohnehin
        // nur scheitern kann.
        if (row.state === 'frozen') return toolError('log_frozen', 'this log is frozen; its repository is unreachable');
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!canWriteThis) return toolError('forbidden', 'no write access to this repository');

        const target = normalizeMediaPath(path);
        if (target === null) {
          return toolError('bad_filename', `not a media path: "${path}" -- pass a bare filename such as "screenshot.png"`);
        }
        const contentType = mediaTypeOf(target);
        if (contentType === null) {
          return toolError('unsupported_type', `unsupported media type for "${target}" -- .png, .jpg and .webp only`);
        }
        // Existiert der Pfad schon, gibt es gar keine URL: ein
        // überschriebenes Bild würde stillschweigend jedes bereits
        // veröffentlichte Release ändern, das darauf zeigt (spec §6). Die
        // Upload-Route lehnt denselben Fall beim Commit noch einmal ab --
        // hier steht der Index, dort GitHub selbst.
        if (reader.media(log_id, target) !== null) {
          return toolError('path_exists', `${target} already exists in this log; pick another filename`);
        }

        const { token, expiresAt } = mintUploadToken(db, {
          logId: log_id, path: target, accountId: who.accountId, contentType,
        });
        return toolOk({
          upload_url: `${baseUrl}/upload/${token}`,
          path: target,
          content_type: contentType,
          expires_at: expiresAt,
          max_bytes: MEDIA_MAX_BYTES,
        });
      },
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
