// Who the app is, as opposed to what a repository contains. A GitHub App
// proves its identity with a short-lived JWT it signs itself, then trades
// that for an installation token (spec §5).

import { createSign } from 'node:crypto';
import type { AppConfig } from './config.ts';

// GitHub rejects a JWT whose iat lies in the future, so back it off far
// enough to absorb clock skew, and it refuses any exp more than ten
// minutes out. Nine minutes leaves room for both.
const SKEW_SECONDS = 60;
const LIFETIME_SECONDS = 540;

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function appJwt(config: AppConfig, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const head = segment({ alg: 'RS256', typ: 'JWT' });
  const payload = segment({
    iat: now - SKEW_SECONDS,
    exp: now + LIFETIME_SECONDS,
    iss: config.appId,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${payload}`);
  return `${head}.${payload}.${signer.sign(config.privateKey, 'base64url')}`;
}

import type { Http } from './http.ts';

const API = 'https://api.github.com';

// Replace a token this long before it nominally expires. A token that
// expires mid-request is a failure the caller cannot distinguish from a
// revoked installation. Generous relative to GitHub's one-hour token
// lifetime, so it costs nothing in production while still giving a slow
// request plenty of room to finish on the token it started with.
const EXPIRY_MARGIN_MS = 100_000;

export type Installations = {
  // The parameter is spelled out rather than imported as RepoRef:
  // lib/github.ts imports Installations from here, and importing back
  // would close a cycle. Structurally it is the same shape.
  //
  // null when the app is not installed on that repository — a normal
  // state, not an error (spec §6: create_log reports no_installation).
  tokenFor(ref: { owner: string; repo: string }): Promise<string | null>;
};

type Minted = { token: string; expiresAtMs: number };

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'release-log-hub',
    authorization: `Bearer ${token}`,
  };
}

export function installations(
  config: AppConfig,
  http: Http,
  nowMs: () => number = Date.now,
): Installations {
  // Keyed by installation, not by repository: every repository of one
  // installation shares its token, and minting is rate-limited.
  const cache = new Map<number, Minted>();

  return {
    async tokenFor(ref) {
      const found = await http(`${API}/repos/${ref.owner}/${ref.repo}/installation`, {
        headers: headers(appJwt(config)),
      });
      if (found.status === 404) return null;
      if (!found.ok) {
        throw new Error(`installation lookup failed: HTTP ${found.status}`);
      }
      const installationId = ((await found.json()) as { id: number }).id;

      const cached = cache.get(installationId);
      if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > nowMs()) {
        return cached.token;
      }

      const minted = await http(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: headers(appJwt(config)),
      });
      if (!minted.ok) {
        throw new Error(`minting an installation token failed: HTTP ${minted.status}`);
      }
      const body = (await minted.json()) as { token: string; expires_at: string };
      // Never persisted: it lives here until it expires (spec §5).
      cache.set(installationId, {
        token: body.token,
        expiresAtMs: Date.parse(body.expires_at),
      });
      return body.token;
    },
  };
}
