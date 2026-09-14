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

export type GitHub = {
  probe(ref: RepoRef): Promise<RepoState>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
  // GitHub entscheidet über Rechte, nicht diese App (spec §5, Entscheidung
  // 14). null heißt "keine Antwort möglich" -- der Aufrufer behandelt das
  // wie 'none', nie wie Schreibrecht.
  collaboratorPermission(ref: RepoRef, login: string): Promise<'admin' | 'write' | 'read' | 'none' | null>;
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
  };
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
  async function authed(ref: RepoRef, path: string): Promise<Response | null> {
    const token = await inst.tokenFor(ref);
    // Not installed: there is nothing to ask, and asking without a token
    // would be a different failure than the one the caller means.
    if (token === null) return null;
    const res = await http(`${API}${path}`, { headers: headers(token) });
    if (res.status !== 401) return res;

    // Exactly one attempt: a 401 means either "token dead" — a fresh one
    // carries it — or "permission gone", and then a tenth would not help
    // either. withRetry deliberately does not retry a 401, because it is
    // an answer, not an outage.
    inst.invalidate(ref);
    const fresh = await inst.tokenFor(ref);
    if (fresh === null) return null;
    return http(`${API}${path}`, { headers: headers(fresh) });
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
  };
}
