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
