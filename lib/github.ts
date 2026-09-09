// The only place that will talk to the network, once Plan 3 fills it in.
// Plan 2 uses the fake below, which computes real git blob SHAs — so the
// sync's diff logic is exercised against the same hashes production will
// see, not against invented identifiers.

import { createHash } from 'node:crypto';

export type RepoRef = { owner: string; repo: string };
export type TreeEntry = { path: string; sha: string; size: number };

export type GitHub = {
  // null when the repo is gone: a deleted repo freezes its log (spec §10).
  head(ref: RepoRef): Promise<string | null>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
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
  };
}
