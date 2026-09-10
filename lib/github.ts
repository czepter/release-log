// The only place that will talk to the network, once Plan 3 fills it in.
// Plan 2 uses the fake below, which computes real git blob SHAs — so the
// sync's diff logic is exercised against the same hashes production will
// see, not against invented identifiers.

import { createHash } from 'node:crypto';
import type { Http } from './http.ts';
import type { Installations } from './appAuth.ts';

export type RepoRef = { owner: string; repo: string };
export type TreeEntry = { path: string; sha: string; size: number };

export type GitHub = {
  // null when the repo is gone: a deleted repo freezes its log (spec §10).
  head(ref: RepoRef): Promise<string | null>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
  // GitHub's immutable id for the repository. It survives a rename and a
  // transfer, which is what lets a later plan tell those apart from a
  // repository claiming an id that belongs to someone else (spec §10).
  repoId(ref: RepoRef): Promise<string | null>;
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
    async head(ref) {
      const entries = entriesOf(ref);
      if (!entries) return null;
      // A stand-in commit id: the hash of every path and blob sha in the
      // tree, so any content change moves the head, exactly as a real
      // commit would.
      const summary = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((e) => `${e.path} ${e.sha}`).join('\n');
      return createHash('sha1').update(summary).digest('hex');
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
    async repoId(ref) {
      return entriesOf(ref) === null ? null : `R_fake_${key(ref)}`;
    },
  };
}

const API = 'https://api.github.com';

type RepoInfo = { nodeId: string; defaultBranch: string };

export function githubClient(inst: Installations, http: Http): GitHub {
  async function authed(ref: RepoRef, path: string): Promise<Response | null> {
    const token = await inst.tokenFor(ref);
    // Not installed: there is nothing to ask, and asking without a token
    // would be a different failure than the one the caller means.
    if (token === null) return null;
    return http(`${API}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'release-log-hub',
        authorization: `Bearer ${token}`,
      },
    });
  }

  async function repoInfo(ref: RepoRef): Promise<RepoInfo | null> {
    const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}`);
    if (res === null || res.status === 404) return null;
    if (!res.ok) throw new Error(`repo lookup failed: HTTP ${res.status}`);
    const body = (await res.json()) as { node_id: string; default_branch: string };
    return { nodeId: body.node_id, defaultBranch: body.default_branch };
  }

  return {
    async repoId(ref) {
      return (await repoInfo(ref))?.nodeId ?? null;
    },

    async head(ref) {
      const info = await repoInfo(ref);
      if (info === null) return null;
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/commits/${info.defaultBranch}`);
      if (res === null || res.status === 404) return null;
      // 409 is how GitHub reports a repository with no commits at all.
      // That is an empty log, not a missing one — but there is no tree to
      // read either, so it answers like a gone repository here.
      if (res.status === 409) return null;
      if (!res.ok) throw new Error(`head lookup failed: HTTP ${res.status}`);
      return ((await res.json()) as { sha: string }).sha;
    },

    async tree(ref, commit) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/git/trees/${commit}?recursive=1`);
      // Never return an empty array for a failure. To the sync an empty
      // tree is indistinguishable from a repository whose files were all
      // deleted, and it would delete every row. head() already answers
      // null for a gone or empty repository, so by the time anything asks
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
  };
}
