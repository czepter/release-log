// The only place that talks to GitHub's network API. fakeGitHub below
// computes real git blob SHAs, so tests exercise the sync's diff logic
// against the same hashes production will see, not against invented
// identifiers.

import { createHash } from 'node:crypto';
import type { Http } from './http.ts';
import type { Installations } from './appAuth.ts';

export type RepoRef = { owner: string; repo: string };
export type TreeEntry = { path: string; sha: string; size: number };

// Four states, because three of them demand different answers: 'gone'
// freezes the log, 'no_installation' keeps syncing skipped without
// freezing (spec §10), 'empty' is a repository that is not a log yet.
// They stay internal — which state applies must never leak into an HTTP
// response (spec §7).
export type RepoState =
  // owner/repo are the CANONICAL name from GitHub's response, not
  // necessarily the ref probe() was called with: GET /repos/{old}/{old}
  // 301-redirects to a renamed repository and fetch follows it, so a
  // stale ref still probes 'ready' — but with the repository's current
  // name in the body. Optional: fakeGitHub and hand-written test fixtures
  // that predate this field don't carry it, and the caller falls back to
  // the ref it probed with.
  | { kind: 'ready'; head: string; nodeId: string; owner?: string; repo?: string }
  | { kind: 'empty'; nodeId: string }
  | { kind: 'no_installation' }
  | { kind: 'gone' };

export type CommitResult =
  | { kind: 'committed'; sha: string }
  // GitHubs eigene Konflikterkennung: 409 heißt "die erwartete SHA stimmt
  // nicht mehr" (jemand hat die Datei seither geändert), 422 auf einem
  // Anlegen-ohne-SHA heißt "unter diesem Pfad liegt schon etwas". Beides
  // verdient dieselbe Antwort -- nicht committen, dem Menschen sagen, dass
  // sich etwas geändert hat -- also bildet putFile beide auf denselben
  // Zustand ab.
  | { kind: 'conflict' }
  | { kind: 'no_installation' };

export type GitHub = {
  probe(ref: RepoRef): Promise<RepoState>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
  // GitHub entscheidet über Rechte, nicht diese App (spec §5, Entscheidung
  // 14). null heißt "keine Antwort möglich" -- der Aufrufer behandelt das
  // wie 'none', nie wie Schreibrecht.
  collaboratorPermission(ref: RepoRef, login: string): Promise<'admin' | 'write' | 'read' | 'none' | null>;
  putFile(ref: RepoRef, path: string, content: Buffer, message: string, expectedSha: string | null): Promise<CommitResult>;
};

// git hashes a blob as sha1("blob <byte length>\0" + content).
export function blobSha(content: Buffer | string): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

export function fakeGitHub(repos: Record<string, Record<string, string | Buffer>>): GitHub {
  const key = (ref: RepoRef): string => `${ref.owner}/${ref.repo}`;

  const entriesOf = (ref: RepoRef): TreeEntry[] | null => {
    const files = repos[key(ref)];
    if (!files) return null;
    return Object.entries(files).map(([path, content]) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      return { path, sha: blobSha(bytes), size: bytes.length };
    });
  };

  return {
    async probe(ref) {
      const entries = entriesOf(ref);
      if (!entries) return { kind: 'gone' };
      const nodeId = `R_fake_${key(ref)}`;
      if (entries.length === 0) return { kind: 'empty', nodeId };
      // A stand-in commit: the hash over every path and blob sha, so any
      // content change moves the head, exactly as a real commit would.
      const summary = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((e) => `${e.path} ${e.sha}`).join('\n');
      return { kind: 'ready', head: createHash('sha1').update(summary).digest('hex'), nodeId };
    },
    async tree(ref) {
      return entriesOf(ref) ?? [];
    },
    async blob(ref, sha) {
      const files = repos[key(ref)];
      if (!files) return null;
      for (const content of Object.values(files)) {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        if (blobSha(bytes) === sha) return bytes;
      }
      return null;
    },
    async collaboratorPermission(ref) {
      return entriesOf(ref) === null ? null : 'write';
    },
    async putFile() {
      // Kein bestehender Test braucht mehr als "es hat geklappt" von der
      // Fake-Seite -- Tests für das eigentliche Konfliktverhalten laufen
      // gegen githubClient mit fakeHttp, wo die Antwort steuerbar ist.
      return { kind: 'committed', sha: 'fake-committed-sha' };
    },
  };
}

// Das Anlegen eines Repos ist der eine Aufruf, der NICHT über die
// Installation laufen kann: GitHubs Berechtigungsreferenz führt
// POST /user/repos nur für Nutzer-Token (spec §5, Entscheidung 23). Er
// steht deshalb neben dem Client statt in ihm -- er bekommt das Token
// gereicht, statt sich eins zu holen, und teilt mit githubClient nur die
// Header-Form.
export type CreateRepoResult =
  | { kind: 'created'; owner: string; repo: string; nodeId: string }
  // 422 auf diesem Endpunkt heißt praktisch immer "diesen Namen gibt es
  // hier schon"; der Name selbst ist vorher geprüft.
  | { kind: 'name_taken' }
  // Token tot oder ohne das nötige Recht -- beides endet beim selben
  // nächsten Schritt: der Mensch meldet sich neu an.
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; status: number };

export type CreateUserRepo = (
  token: string, input: { name: string; description: string; private: boolean },
) => Promise<CreateRepoResult>;

export function userRepoCreator(http: Http): CreateUserRepo {
  return async (token, input) => {
    const res = await http(`${API}/user/repos`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        private: input.private,
        // Kein auto_init: die erste release-log.json und die README schreibt
        // das Installations-Token (spec §6), nicht GitHubs Vorlage. Ein
        // angelegtes Repo wäre sonst schon belegt, und der erste eigene
        // Commit wäre ein Ersetzen statt eines Anlegens.
        auto_init: false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      }),
    });
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    if (res.status === 422) return { kind: 'name_taken' };
    if (!res.ok) return { kind: 'unavailable', status: res.status };
    const body = (await res.json()) as { name: string; node_id: string; owner: { login: string } };
    // Der Name kommt aus der Antwort, nicht aus der Eingabe: GitHub
    // normalisiert ihn (Leerzeichen werden zu Bindestrichen), und was
    // danach gilt, ist was zurückkommt.
    return { kind: 'created', owner: body.owner.login, repo: body.name, nodeId: body.node_id };
  };
}

// Die Vorschläge im Dialog „Neues Log" (spec §8: ein bestehendes Repo
// übernehmen). Ebenfalls mit dem Nutzer-Token: /user/installations liefert
// nur Installationen DIESER App, auf die der Mensch Zugriff hat, und deren
// Repo-Liste nur, was er selbst sehen darf -- genau die Schnittmenge aus
// „App freigegeben" und „meins". Nur das eigene Konto, wie bei createLog.
export type InstalledRepo = { name: string; private: boolean };

// "selected" heißt: die Installation trägt eine Liste einzelner Repos. Ein
// eben erst angelegtes Repo steht nie darauf, also wäre es für die App
// unsichtbar -- create_log legte es an und scheiterte danach am Probe.
export type RepoSelection = 'all' | 'selected';

export type ListInstalledRepos = (token: string, owner: string) => Promise<
  | { kind: 'ok'; selection: RepoSelection; repos: InstalledRepo[] }
  // Die App ist auf dem eigenen Konto gar nicht installiert. Das ist kein
  // Fehler, aber auch kein leeres Konto -- wer das nicht unterscheidet,
  // zeigt eine leere Vorschlagsliste und verschweigt den Grund.
  | { kind: 'no_installation' }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; status: number }
>;

// ponytail: höchstens 10 Seiten (1000 Repos); mehr braucht erst eine Suche.
const MAX_REPO_PAGES = 10;

export function userInstalledRepos(http: Http): ListInstalledRepos {
  return async (token, owner) => {
    const found = await http(`${API}/user/installations?per_page=100`, { headers: headers(token) });
    if (found.status === 401 || found.status === 403) return { kind: 'unauthorized' };
    if (!found.ok) return { kind: 'unavailable', status: found.status };
    const { installations } = (await found.json()) as {
      installations: { id: number; account: { login: string }; repository_selection?: string }[];
    };
    const own = installations.find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
    if (!own) return { kind: 'no_installation' };
    // Nur das ausdrückliche "selected" schränkt ein. Fehlt das Feld, wird
    // nicht geraten und nichts gesperrt.
    const selection: RepoSelection = own.repository_selection === 'selected' ? 'selected' : 'all';

    const repos: InstalledRepo[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const res = await http(`${API}/user/installations/${own.id}/repositories?per_page=100&page=${page}`, { headers: headers(token) });
      if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
      if (!res.ok) return { kind: 'unavailable', status: res.status };
      const body = (await res.json()) as { repositories: { name: string; private: boolean }[] };
      repos.push(...body.repositories.map((r) => ({ name: r.name, private: r.private })));
      if (body.repositories.length < 100) break;
    }
    return { kind: 'ok', selection, repos };
  };
}

// Wohin ein Konto geschickt wird, das die App noch nicht installiert hat.
// Die Adresse braucht den Slug der App, und den kennt die Konfiguration
// nicht -- GET /app nennt ihn, mit dem JWT, das die App ohnehin signiert.
// Ein Slug ändert sich nicht, also wird die Antwort behalten; ein
// Fehlschlag nicht, sonst bliebe der Link für die Lebensdauer des
// Prozesses weg. null heißt: den Satz ohne Link zeigen, nie einen Knopf,
// der ins Leere führt.
export type AppInstallUrl = () => Promise<string | null>;

export function appInstallUrl(http: Http, jwt: () => string): AppInstallUrl {
  let known: string | null = null;
  return async () => {
    if (known !== null) return known;
    const res = await http(`${API}/app`, { headers: headers(jwt()) });
    if (!res.ok) return null;
    const { html_url: page } = (await res.json()) as { html_url?: string };
    if (typeof page !== 'string') return null;
    known = `${page}/installations/new`;
    return known;
  };
}

// GitHubs Contents-API-Pfad trägt "/" als echten Pfadtrenner -- ihn als
// Ganzes zu kodieren würde ihn selbst mitkodieren und die URL brechen.
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

const API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'release-log-hub',
    authorization: `Bearer ${token}`,
  };
}

export function githubClient(inst: Installations, http: Http): GitHub {
  async function authed(ref: RepoRef, path: string, init?: RequestInit): Promise<Response | null> {
    const token = await inst.tokenFor(ref);
    // Not installed: there is nothing to ask, and asking without a token
    // would be a different failure than the one the caller means.
    if (token === null) return null;
    const res = await http(`${API}${path}`, { ...init, headers: headers(token) });
    if (res.status !== 401) return res;

    // Exactly one attempt: a 401 means either "token dead" — a fresh one
    // carries it — or "permission gone", and then a tenth would not help
    // either. withRetry deliberately does not retry a 401, because it is
    // an answer, not an outage.
    inst.invalidate(ref);
    const fresh = await inst.tokenFor(ref);
    if (fresh === null) return null;
    return http(`${API}${path}`, { ...init, headers: headers(fresh) });
  }

  return {
    async probe(ref) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}`);
      if (res === null) return { kind: 'no_installation' };
      if (res.status === 404) return { kind: 'gone' };
      if (!res.ok) throw new Error(`repo lookup failed: HTTP ${res.status}`);
      const info = (await res.json()) as { node_id: string; default_branch: string; full_name?: string };
      // full_name is GitHub's canonical "owner/repo" post-redirect: a
      // stale ref (e.g. after a rename) still lands here via a 301, but
      // the body names where the repository actually lives now. Optional
      // here only because some hand-written test fixtures predate this
      // field — the real API always sends it.
      const canonical = info.full_name ? info.full_name.split('/') : null;

      const commits = await authed(ref, `/repos/${ref.owner}/${ref.repo}/commits/${info.default_branch}`);
      if (commits === null) return { kind: 'no_installation' };
      // 409 reports a repository with no commits at all, 404 a branch
      // that does not (yet) exist. Both are "there, but nothing to
      // read" — and deliberately not 'gone', since freezing is the
      // expensive direction: a log only thaws through another
      // successful sync.
      if (commits.status === 409 || commits.status === 404) return { kind: 'empty', nodeId: info.node_id };
      if (!commits.ok) throw new Error(`head lookup failed: HTTP ${commits.status}`);
      return {
        kind: 'ready',
        head: ((await commits.json()) as { sha: string }).sha,
        nodeId: info.node_id,
        ...(canonical ? { owner: canonical[0], repo: canonical[1] } : {}),
      };
    },

    async tree(ref, commit) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/git/trees/${commit}?recursive=1`);
      // Never return an empty array for a failure. To the sync an empty
      // tree is indistinguishable from a repository whose files were all
      // deleted, and it would delete every row. probe() already answers
      // 'gone' or 'empty' for those cases, so by the time anything asks
      // for a tree there is one to read.
      if (res === null) throw new Error(`tree unavailable for ${ref.owner}/${ref.repo}: no installation token`);
      if (!res.ok) throw new Error(`tree lookup failed: HTTP ${res.status}`);
      const body = (await res.json()) as {
        truncated: boolean;
        tree: { path: string; type: string; sha: string; size?: number }[];
      };
      // A truncated tree is indistinguishable, to the sync, from a
      // repository whose remaining files were deleted — and the sync would
      // delete their rows. Refuse rather than silently lose content.
      if (body.truncated) {
        throw new Error(`tree for ${ref.owner}/${ref.repo}@${commit} is truncated; refusing a partial sync`);
      }
      return body.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
    },

    async blob(ref, sha) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/git/blobs/${sha}`);
      // Same reasoning as tree(): a null return here reads to the sync as
      // "file broken, drop it" rather than "could not check" — and unlike
      // tree(), that loss is silent and permanent (the row is deleted, and
      // the resulting error row's sha matches the unchanged tree entry on
      // every later sync, so it is never retried). Throw instead.
      if (res === null) throw new Error(`blob unavailable for ${ref.owner}/${ref.repo}@${sha}: no installation token`);
      // A blob named by a tree GitHub just served cannot legitimately be
      // absent, so a 404 here is lost access or a transient glitch, not a
      // deleted file — fold it into the same throw as every other non-ok.
      if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
      const body = (await res.json()) as { encoding: string; content: string };
      if (body.encoding !== 'base64') {
        throw new Error(`unexpected blob encoding "${body.encoding}" for ${sha}`);
      }
      // GitHub wraps base64 content at 60 characters; Buffer.from ignores
      // the newlines, but strip them so the input is what it claims to be.
      return Buffer.from(body.content.replace(/\n/g, ''), 'base64');
    },

    async collaboratorPermission(ref, login) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/collaborators/${encodeURIComponent(login)}/permission`);
      if (res === null || res.status === 404) return null;
      if (!res.ok) throw new Error(`collaborator permission lookup failed: HTTP ${res.status}`);
      const body = (await res.json()) as { permission?: string };
      return body.permission === 'admin' || body.permission === 'write' || body.permission === 'read'
        ? body.permission
        : 'none';
    },

    async putFile(ref, path, content, message, expectedSha) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: content.toString('base64'),
          ...(expectedSha !== null ? { sha: expectedSha } : {}),
        }),
      });
      if (res === null) return { kind: 'no_installation' };
      if (res.status === 409 || res.status === 422) return { kind: 'conflict' };
      if (!res.ok) throw new Error(`commit to ${path} failed: HTTP ${res.status}`);
      const body = (await res.json()) as { content: { sha: string } };
      return { kind: 'committed', sha: body.content.sha };
    },
  };
}
