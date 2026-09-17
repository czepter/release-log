// „Log anlegen" (spec §6): ein Repo entsteht, bekommt seine erste
// release-log.json und eine README, und der Index sieht es sofort danach.
// Zwei Wege führen hierher -- das MCP-Werkzeug create_log und der Knopf im
// Dashboard -- und beide müssen dieselbe Reihenfolge einhalten, deshalb
// steht sie einmal hier und nicht zweimal dort.
//
// Zwei Token sind im Spiel, und die Trennung ist der ganze Punkt
// (Entscheidung 23): Das Repo legt das GitHub-NUTZER-Token an, weil
// POST /user/repos nur damit geht. Alles danach -- beide Dateien, der
// Abgleich -- läuft über das INSTALLATIONS-Token, wie jeder andere
// Repo-Zugriff dieses Diensts.

import { randomBytes } from 'node:crypto';
import type { Db } from './db/client.ts';
import { log } from './db/schema.ts';
import { and, eq } from 'drizzle-orm';
import type { GitHub, RepoRef, CreateUserRepo } from './github.ts';
import type { UserTokens } from './userTokens.ts';
import { parseConfig } from './document.ts';
import type { LogConfig } from './document.ts';

// Crockford-Base32: ohne i, l, o und u, damit eine vorgelesene oder
// abgetippte Kennung nicht an einem verwechselten Zeichen scheitert. Zwölf
// Zeichen sind 60 Bit -- eine Kollision ist kein Thema, und der
// Eindeutigkeitsindex der Datenbank fängt sie ohnehin ab.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newLogId(random: (bytes: number) => Buffer = randomBytes): string {
  // 256 teilt sich ohne Rest durch 32, also verzerrt das Modulo nichts.
  return [...random(12)].map((byte) => ALPHABET[byte % 32]).join('');
}

// GitHubs eigene Regel für Repo-Namen, so weit sie hier zählt. Der Aufruf
// scheitert sonst erst drüben mit einer 422, die wie „Name schon vergeben"
// aussieht -- und das wäre die falsche Auskunft.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type CreateLogInput = {
  accountId: number;
  login: string;
  owner: string;
  repoName: string;
  product: string;
  view?: string;
  visibility?: string;
};

export type CreateLogError =
  | 'forbidden' | 'invalid_document' | 'conflict' | 'reauth_required'
  | 'repo_not_installed' | 'github_unavailable';

export type CreateLogResult =
  | { ok: true; value: { logId: string; url: string; owner: string; repo: string } }
  | { ok: false; error: CreateLogError; message: string };

export type CreateLogDeps = {
  db: Db;
  gh: GitHub;
  users: UserTokens;
  createRepo: CreateUserRepo;
  // Wartet, bis der neue Log im Index steht. Über dieselbe Warteschlange
  // wie jeder andere Abgleich: der Push, den unsere beiden Commits selbst
  // auslösen, kommt als Webhook zurück, und zwei gleichzeitige Läufe auf
  // demselben Repo würden einander die Sweeps unter den Füßen wegziehen.
  syncNow: (ref: RepoRef) => Promise<void>;
  baseUrl: string;
  newId?: () => string;
};

// Die Seite, auf der man ein Repo zur Auswahl einer Installation
// hinzufügt. Ohne App-Slug ist das die allgemeine Übersicht -- sie führt
// zum Ziel, ohne dass der Dienst raten muss, wie er selbst heißt.
const INSTALL_URL = 'https://github.com/settings/installations';

function readme(product: string, logId: string, baseUrl: string): string {
  return [
    `# ${product}`,
    '',
    'Dieses Repository ist ein Release-Log. `release-log.json` beschreibt den',
    'Log, jede Datei unter `releases/` ist eine Version, `media/` trägt ihre',
    'Bilder.',
    '',
    `Öffentlich zu lesen unter ${baseUrl}/l/${logId}.`,
    '',
    'Geschrieben wird er von Hand im Repo oder über MCP; beide Wege sind',
    'gleichberechtigt, und wer zuletzt schreibt, merkt es.',
    '',
  ].join('\n');
}

export async function createLog(deps: CreateLogDeps, input: CreateLogInput): Promise<CreateLogResult> {
  const { db, gh, users, createRepo, syncNow, baseUrl } = deps;
  const newId = deps.newId ?? newLogId;

  // owner steht in der Eingabe, weil spec §6 ihn führt -- unterstützt ist
  // aber nur das eigene Konto: POST /orgs/{org}/repos ist ein anderer
  // Endpunkt mit anderen Rechten, und niemand hat ihn bisher gebraucht.
  // Lieber eine klare Absage als ein Aufruf, der anderswo landet.
  if (input.owner !== input.login) {
    return {
      ok: false, error: 'forbidden',
      message: `create_log only creates repositories on your own account (${input.login}), not on ${input.owner}`,
    };
  }
  if (!REPO_NAME.test(input.repoName)) {
    return {
      ok: false, error: 'invalid_document',
      message: 'repo_name: 1-100 characters from A-Z a-z 0-9 . _ -, starting with a letter or digit',
    };
  }

  const logId = newId();
  // Dieselbe Prüfung, die der Index anlegt -- ein Dokument, das er
  // verwerfen würde, erreicht das Repo nicht (spec §6).
  const parsed = parseConfig({
    id: logId, product: input.product, view: input.view, visibility: input.visibility, curation_notes: null,
  });
  if (!parsed.ok) return { ok: false, error: 'invalid_document', message: parsed.errors.join('; ') };
  const config: LogConfig = parsed.value;

  const token = await users.tokenFor(input.accountId);
  if (!token.ok) {
    return token.error === 'reauth_required'
      ? {
        ok: false, error: 'reauth_required',
        message: `sign in again at ${baseUrl}/auth/github/login, then retry -- creating a repository needs a GitHub user token`,
      }
      : { ok: false, error: 'github_unavailable', message: 'GitHub did not answer the token refresh; try again' };
  }

  const created = await createRepo(token.token, {
    name: input.repoName,
    description: `Release-Log: ${config.product}`,
    private: config.visibility === 'private',
  });
  if (created.kind === 'name_taken') {
    return { ok: false, error: 'conflict', message: `${input.login}/${input.repoName} already exists; pick another name` };
  }
  if (created.kind === 'unauthorized') {
    // Das Token war noch nicht abgelaufen, aber GitHub nimmt es nicht an --
    // widerrufen, zurückgezogen, oder die App darf keine Repos anlegen.
    // Alles drei endet bei derselben Handlung.
    users.forget(input.accountId);
    return {
      ok: false, error: 'reauth_required',
      message: `GitHub refused the stored user token; sign in again at ${baseUrl}/auth/github/login`,
    };
  }
  if (created.kind === 'unavailable') {
    return { ok: false, error: 'github_unavailable', message: `GitHub answered HTTP ${created.status} on creating the repository` };
  }

  const ref: RepoRef = { owner: created.owner, repo: created.repo };

  // Ab hier existiert das Repo. Sieht das Installations-Token es nicht,
  // ist Weiterschreiben sinnlos: es entstünde ein Log, den der Index nie zu
  // sehen bekommt (spec §6). Bei repository_selection=selected ist genau
  // das der Normalfall.
  const probed = await gh.probe(ref);
  if (probed.kind === 'no_installation' || probed.kind === 'gone') {
    return {
      ok: false, error: 'repo_not_installed',
      message: `${ref.owner}/${ref.repo} was created, but the GitHub App cannot see it. Add it to the installation at ${INSTALL_URL}, then create the log again (or delete the empty repository).`,
    };
  }

  const configCommit = await gh.putFile(
    ref, 'release-log.json', Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'),
    'create release log', null,
  );
  if (configCommit.kind === 'no_installation') {
    return {
      ok: false, error: 'repo_not_installed',
      message: `${ref.owner}/${ref.repo} was created, but the GitHub App cannot write to it. Add it to the installation at ${INSTALL_URL}.`,
    };
  }
  if (configCommit.kind === 'conflict') {
    return { ok: false, error: 'conflict', message: `${ref.owner}/${ref.repo} already carries a release-log.json` };
  }

  // Die README ist Beiwerk, kein Teil des Logs: scheitert sie, steht der
  // Log trotzdem. Ein Abbruch hier ließe ein fertiges Repo als Fehler
  // aussehen.
  await gh.putFile(
    ref, 'README.md', Buffer.from(readme(config.product, logId, baseUrl), 'utf8'), 'add readme', null,
  ).catch(() => undefined);

  await syncNow(ref);

  // Der Abgleich hat die Zeile angelegt -- oder eben nicht, wenn GitHub
  // die frischen Commits noch nicht ausliefert. Dann ist der Log echt und
  // unterwegs, und die nächste Reconcile-Runde holt ihn ein; das ist eine
  // Auskunft und kein Fehler.
  const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
  if (!row) {
    return {
      ok: false, error: 'github_unavailable',
      message: `${ref.owner}/${ref.repo} was created with its release-log.json, but the index has not picked it up yet; it appears within the hour without any further action`,
    };
  }

  return { ok: true, value: { logId, url: `${baseUrl}/l/${logId}`, owner: ref.owner, repo: ref.repo } };
}

// „Bestehendes Repo übernehmen" (spec §8). Kein Nutzer-Token: das Repo gibt
// es schon, also läuft alles über die Installation. Dafür eine Prüfung, die
// createLog nicht braucht: das Installations-Token darf mehr als der
// Mensch, also muss GitHub bestätigen, dass ER schreiben darf.
export async function adoptLog(deps: CreateLogDeps, input: CreateLogInput): Promise<CreateLogResult> {
  const { db, gh, syncNow, baseUrl } = deps;
  const newId = deps.newId ?? newLogId;

  if (input.owner !== input.login) {
    return {
      ok: false, error: 'forbidden',
      message: `only repositories on your own account (${input.login}) can be adopted, not on ${input.owner}`,
    };
  }
  if (!REPO_NAME.test(input.repoName)) {
    return {
      ok: false, error: 'invalid_document',
      message: 'repo_name: 1-100 characters from A-Z a-z 0-9 . _ -, starting with a letter or digit',
    };
  }

  const asked: RepoRef = { owner: input.owner, repo: input.repoName };
  const probed = await gh.probe(asked);
  if (probed.kind === 'no_installation' || probed.kind === 'gone') {
    return {
      ok: false, error: 'repo_not_installed',
      message: `The GitHub App cannot see ${asked.owner}/${asked.repo}. Add it to the installation at ${INSTALL_URL}, then try again.`,
    };
  }
  const ref: RepoRef = probed.kind === 'ready'
    ? { owner: probed.owner ?? asked.owner, repo: probed.repo ?? asked.repo }
    : asked;

  const permission = await gh.collaboratorPermission(ref, input.login);
  if (permission !== 'admin' && permission !== 'write') {
    return { ok: false, error: 'forbidden', message: `you have no write access to ${ref.owner}/${ref.repo}` };
  }

  const byRepo = () => db.select().from(log)
    .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all()[0];
  const entry = probed.kind === 'ready'
    ? (await gh.tree(ref, probed.head)).find((e) => e.path === 'release-log.json')
    : undefined;

  if (entry) {
    const bytes = await gh.blob(ref, entry.sha);
    let raw: unknown = null;
    try { raw = JSON.parse(String(bytes)); } catch { /* parseConfig meldet es */ }
    const parsed = parseConfig(raw);
    if (!parsed.ok) {
      return { ok: false, error: 'invalid_document', message: `release-log.json in ${ref.owner}/${ref.repo}: ${parsed.errors.join('; ')}` };
    }
    // Eine kopierte Datei trägt die id eines anderen Logs -- der Index würde
    // sie diesem Repo nicht geben, und die Antwort zeigte ins Leere.
    const holder = db.select().from(log).where(eq(log.publicId, parsed.value.id)).all()[0];
    // Ein schon indiziertes Repo landet ebenfalls hier: seine eigene id ist
    // vergeben.
    if (holder) {
      return {
        ok: false, error: 'conflict',
        message: holder.repoOwner === ref.owner && holder.repoName === ref.repo
          ? `${ref.owner}/${ref.repo} already has a release log`
          : `the id ${parsed.value.id} in release-log.json already belongs to ${holder.repoOwner}/${holder.repoName}`,
      };
    }
  } else {
    const parsed = parseConfig({
      id: newId(), product: input.product, view: input.view, visibility: input.visibility, curation_notes: null,
    });
    if (!parsed.ok) return { ok: false, error: 'invalid_document', message: parsed.errors.join('; ') };
    const commit = await gh.putFile(
      ref, 'release-log.json', Buffer.from(`${JSON.stringify(parsed.value, null, 2)}\n`, 'utf8'),
      'adopt repository as release log', null,
    );
    if (commit.kind === 'no_installation') {
      return { ok: false, error: 'repo_not_installed', message: `The GitHub App cannot write to ${ref.owner}/${ref.repo}. Add it to the installation at ${INSTALL_URL}.` };
    }
    if (commit.kind === 'conflict') {
      return { ok: false, error: 'conflict', message: `${ref.owner}/${ref.repo} got a release-log.json in the meantime; try again` };
    }
  }

  await syncNow(ref);
  const row = byRepo();
  if (!row) {
    return {
      ok: false, error: 'github_unavailable',
      message: `${ref.owner}/${ref.repo} carries its release-log.json, but the index has not picked it up yet; it appears within the hour without any further action`,
    };
  }
  return { ok: true, value: { logId: row.publicId, url: `${baseUrl}/l/${row.publicId}`, owner: ref.owner, repo: ref.repo } };
}
