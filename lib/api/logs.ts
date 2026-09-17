import { eq } from 'drizzle-orm';
import { log, release, media, syncError, repoPermission } from '../db/schema.ts';
import { parseConfig } from '../document.ts';
import type { ReleaseDoc } from '../document.ts';
import { sortReleases } from '../order.ts';
import { createLog, adoptLog } from '../createLog.ts';
import { mediaTypeOf } from '../mediaTypes.ts';
import { MEDIA_MAX_BYTES } from '../index.ts';
import { logAccess } from '../access.ts';
import type { LoggedIn, LogRow } from '../access.ts';
import type { Core, Reply } from './core.ts';
import { ok, fail, NOT_FOUND, FORBIDDEN, text, field } from './core.ts';

function summary(row: LogRow) {
  return {
    id: row.publicId, product: row.product, owner: row.repoOwner, repo: row.repoName,
    view: row.view, visibility: row.visibility, state: row.state, indexedAt: row.indexedAt,
  };
}

// A frozen log is never "writable" for anyone -- GitHub answers a
// permission lookup on a deleted repo with 404. Admins see it anyway, and
// for exactly those rows GitHub is not asked at all (plan 6, deviation 7).
export async function listLogs({ auth }: Core, who: LoggedIn): Promise<Reply> {
  const rows = auth.db.select().from(log).all();
  const visible = await Promise.all(rows.map(async (row) =>
    (row.state === 'frozen' && who.isAdmin)
    || await auth.perms.canWrite(who.accountId, who.login, row.publicId, { owner: row.repoOwner, repo: row.repoName })));
  return ok({ logs: rows.filter((_, i) => visible[i]).map(summary) });
}

const CREATE_STATUS: Record<string, number> = {
  forbidden: 403, invalid_document: 400, conflict: 409, repo_not_installed: 409, reauth_required: 401,
};

export async function createLogApi({ auth }: Core, who: LoggedIn, input: unknown): Promise<Reply> {
  // existing: true übernimmt ein vorhandenes Repo, statt eins anzulegen.
  const run = field(input, 'existing') === true ? adoptLog : createLog;
  const created = await run(
    { db: auth.db, gh: auth.gh, users: auth.users, createRepo: auth.createRepo, syncNow: auth.syncNow, baseUrl: auth.baseUrl, maxLogsPerOwner: auth.maxLogsPerOwner },
    {
      accountId: who.accountId, login: who.login, owner: who.login,
      repoName: (text(input, 'repo_name') ?? '').trim(),
      product: (text(input, 'product') ?? '').trim(),
      view: text(input, 'view') ?? undefined,
      visibility: text(input, 'visibility') ?? undefined,
    },
  );
  if (created.ok) return ok({ logId: created.value.logId, url: created.value.url }, 201);
  // Ein Fehlschlag heißt oft, dass auf GitHub trotzdem etwas entstanden ist
  // (das Repo). Die Nachricht aus createLog sagt, was als Nächstes zu tun ist.
  return fail(CREATE_STATUS[created.error] ?? 502, created.error, created.message);
}

// Die Vorschläge im Dialog „Neues Log“: Repos auf dem eigenen Konto, die
// die App sehen darf; hasLog markiert die, die schon ein Log sind.
export async function listRepoCandidates({ auth }: Core, who: LoggedIn): Promise<Reply> {
  const reauth = fail(401, 'reauth_required', 'Für die Repository-Liste bitte neu bei GitHub anmelden.');
  const token = await auth.users.tokenFor(who.accountId);
  if (!token.ok) return token.error === 'reauth_required' ? reauth : fail(502, 'github_unavailable', 'GitHub antwortet gerade nicht.');
  const listed = await auth.listRepos(token.token, who.login);
  if (listed.kind === 'unauthorized') {
    auth.users.forget(who.accountId);
    return reauth;
  }
  if (listed.kind === 'unavailable') return fail(502, 'github_unavailable', `GitHub antwortete mit HTTP ${listed.status}.`);
  const withLog = new Set(auth.db.select({ name: log.repoName }).from(log).where(eq(log.repoOwner, who.login)).all().map((r) => r.name));
  const repos = listed.repos
    .map((r) => ({ name: r.name, private: r.private, hasLog: withLog.has(r.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return ok({ repos });
}

export async function logDetail({ auth }: Core, who: LoggedIn, logId: string): Promise<Reply> {
  const access = await logAccess(auth, who, logId, { frozenAdmin: true });
  if (!access.ok) return access.status === 404 ? NOT_FOUND : FORBIDDEN;
  const { row, ref } = access;

  const docs = auth.db.select().from(release).where(eq(release.logId, logId)).all()
    .map((r) => JSON.parse(r.doc) as ReleaseDoc);
  const releases = sortReleases(docs)
    .map((r) => ({ version: r.version, date: r.date, published_at: r.published_at, headline: r.headline }));

  // Live, nicht aus einer Tabelle: ein angemeldetes, berechtigtes Konto
  // darf den Installationsstand sehen (plan 6, deviation 5).
  const probe = await auth.gh.probe(ref);
  const installation = probe.kind === 'no_installation' ? 'no_installation' : probe.kind === 'gone' ? 'gone' : 'reachable';

  return ok({
    ...summary(row),
    curationNotes: row.curationNotes,
    configBlobSha: row.configBlobSha,
    installation,
    errors: auth.db.select().from(syncError).where(eq(syncError.logId, logId)).all().map((e) => ({ path: e.path, message: e.message })),
    releases,
    media: auth.db.select({ path: media.path }).from(media).where(eq(media.logId, logId)).all().map((m) => m.path).sort(),
  });
}

// Wer ins Repo schreibt, braucht ein erreichbares Repo: eingefroren heißt
// hier 409, bevor GitHub überhaupt gefragt wird.
async function writableLog(core: Core, who: LoggedIn, logId: string) {
  const row = core.auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
  if (row?.state === 'frozen') return { ok: false as const, reply: fail(409, 'log_frozen', 'Das Repository dieses Logs ist nicht erreichbar.') };
  const access = await logAccess(core.auth, who, logId, { frozenAdmin: false });
  if (!access.ok) return { ok: false as const, reply: access.status === 404 ? NOT_FOUND : FORBIDDEN };
  return access;
}

export async function updateSettings(core: Core, who: LoggedIn, logId: string, input: unknown): Promise<Reply> {
  const access = await writableLog(core, who, logId);
  if (!access.ok) return access.reply;
  const { row, ref } = access;

  const notes = text(input, 'curation_notes');
  // Dieselbe Prüfung wie der Index (spec §6): ein Dokument, das der Index
  // verwerfen würde, erreicht das Repo nicht.
  const parsed = parseConfig({
    id: row.publicId, product: row.product,
    view: text(input, 'view'), visibility: text(input, 'visibility'),
    curation_notes: notes === '' ? null : notes,
  });
  if (!parsed.ok) return fail(400, 'invalid_document', parsed.errors.join('; '));

  const content = Buffer.from(JSON.stringify(parsed.value, null, 2) + '\n', 'utf8');
  // Nie in die Datenbank: sonst gäbe es Einstellungen, die ein Neubau des
  // Index verliert (spec §8). Der Abgleich nach dem Commit zieht sie nach.
  const result = await core.auth.gh.putFile(ref, 'release-log.json', content, 'update release-log.json settings via dashboard', text(input, 'expected_sha') || null);
  if (result.kind === 'conflict') return fail(409, 'conflict', 'Jemand anderes hat die Einstellungen inzwischen geändert. Bitte neu laden.');
  if (result.kind === 'no_installation') return fail(502, 'no_installation', 'Die GitHub-Installation erreicht dieses Repository gerade nicht.');
  core.auth.onRepoWrite(ref);
  return ok({ ok: true });
}

export async function uploadMedia(core: Core, who: LoggedIn, logId: string, rawFilename: string | undefined, bytes: Buffer): Promise<Reply> {
  const access = await writableLog(core, who, logId);
  if (!access.ok) return access.reply;

  let filename: string;
  try {
    filename = decodeURIComponent(rawFilename ?? '');
  } catch {
    return fail(400, 'bad_filename', 'Ungültiger Dateiname.');
  }
  // Ein reiner Dateiname, keine Pfadstruktur: media/<Name> ist die einzige
  // Form, die dieser Upload je erzeugen darf.
  if (filename === '' || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    return fail(400, 'bad_filename', 'Ungültiger Dateiname.');
  }
  if (!mediaTypeOf(filename)) return fail(415, 'unsupported_type', 'Nur PNG, JPG oder WebP.');
  if (bytes.length === 0) return fail(400, 'empty_body', 'Die Datei ist leer.');
  if (bytes.length > MEDIA_MAX_BYTES) return fail(413, 'payload_too_large', 'Die Datei ist zu groß.');

  // expectedSha null: ein Upload legt immer an, ersetzt nie -- ein
  // überschriebenes Bild würde jedes veröffentlichte Release still ändern.
  const path = `media/${filename}`;
  const result = await core.auth.gh.putFile(access.ref, path, bytes, `add ${path} via dashboard`, null);
  if (result.kind === 'conflict') return fail(409, 'path_exists', 'Unter diesem Namen liegt schon eine Datei.');
  if (result.kind === 'no_installation') return fail(502, 'no_installation', 'Die GitHub-Installation erreicht dieses Repository gerade nicht.');
  core.auth.onRepoWrite(access.ref);
  return ok({ path });
}

export async function deleteLog({ auth }: Core, who: LoggedIn, logId: string, input: unknown): Promise<Reply> {
  const access = await logAccess(auth, who, logId, { frozenAdmin: true });
  if (!access.ok) return access.status === 404 ? NOT_FOUND : FORBIDDEN;
  if (text(input, 'confirm_name') !== access.row.product) {
    return fail(400, 'confirm_mismatch', `Der eingegebene Name stimmt nicht mit „${access.row.product}" überein. Nichts wurde gelöscht.`);
  }
  auth.db.delete(release).where(eq(release.logId, logId)).run();
  auth.db.delete(media).where(eq(media.logId, logId)).run();
  auth.db.delete(syncError).where(eq(syncError.logId, logId)).run();
  auth.db.delete(repoPermission).where(eq(repoPermission.logId, logId)).run();
  auth.db.delete(log).where(eq(log.publicId, logId)).run();
  return ok({ deleted: true });
}
