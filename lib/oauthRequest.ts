// Die Prüfung einer /oauth/authorize-Anfrage. Zwei Stellen fragen sie: die
// Zustimmungsseite (Nuxt, über lib/api/consent.ts) und das Einlösen per
// POST im Kern. Beide müssen gleich urteilen -- sonst zeigt die Seite eine
// Zustimmung, die der POST danach verweigert, oder umgekehrt.

import { findClient } from './oauth.ts';
import { isValidCodeChallenge } from './pkce.ts';
import type { LoggedIn } from './access.ts';
import type { Auth } from '../server.ts';

export const ALLOWED_SCOPES = ['logs:read', 'logs:write'];

export type AuthorizeCheck =
  | { kind: 'error'; reason: 'unknown_client' | 'bad_redirect_uri' }
  | { kind: 'redirect'; location: string }
  | { kind: 'login'; location: string }
  | {
    kind: 'ok'; client: { clientId: string; clientName: string }; redirectUri: string;
    state: string; scope: string; codeChallenge: string; who: LoggedIn;
  };

// Task 4's isAcceptableRedirectUri checks a value being REGISTERED (must be
// https, or http on loopback). This checks a value PRESENTED at /oauth/authorize
// against what was registered -- exact match, except the redirect_uri's port
// may vary from what was registered when both are loopback (RFC 8252): a
// native client picks its callback port at OS-assigned random each run, so
// pinning one exact port at registration time would be unusable.
export function redirectUriMatches(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }
  if (presentedUrl.protocol !== 'http:') return false;
  // URL.hostname returns the bracketed form for IPv6 ('[::1]', not '::1');
  // both are listed so an already-unbracketed value still matches.
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(presentedUrl.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return reg.protocol === 'http:' && reg.hostname === presentedUrl.hostname
        && reg.pathname === presentedUrl.pathname && reg.search === presentedUrl.search;
    } catch {
      return false;
    }
  });
}

// `search` ist die rohe Query der ursprünglichen GET-Anfrage (ohne "?"):
// wer nicht angemeldet ist, kommt nach dem Login genau dorthin zurück.
export function checkAuthorizeRequest(
  auth: Auth, method: 'GET' | 'POST', params: URLSearchParams, search: string, who: LoggedIn | null,
): AuthorizeCheck {
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const client = findClient(auth.db, clientId);
  // Unknown client or an unregistered redirect_uri: never redirect --
  // there is no validated destination to send the error to (spec §5,
  // "redirect URIs are checked exactly").
  if (!client) return { kind: 'error', reason: 'unknown_client' };
  if (!redirectUriMatches(client.redirectUris, redirectUri)) return { kind: 'error', reason: 'bad_redirect_uri' };

  // From here on redirectUri is validated -- every further error may go there.
  const state = params.get('state') ?? '';
  const withError = (error: string): AuthorizeCheck => {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    if (state) target.searchParams.set('state', state);
    return { kind: 'redirect', location: target.toString() };
  };

  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? '';
  // response_type only applies to the initial request (GET) -- it is not
  // one of the fields the consent form round-trips, so requiring it again
  // on POST would reject every decision submission. isValidCodeChallenge:
  // with S256 a challenge is always 43 base64url characters (RFC 7636 §4.2).
  if ((method === 'GET' && params.get('response_type') !== 'code') || !isValidCodeChallenge(codeChallenge) || codeChallengeMethod !== 'S256') {
    return withError('invalid_request');
  }
  const scope = params.get('scope') ?? '';
  const scopes = scope.split(' ').filter((s) => s !== '');
  if (scopes.length === 0 || !scopes.every((s) => ALLOWED_SCOPES.includes(s))) return withError('invalid_scope');

  if (!who) {
    const next = `/oauth/authorize?${search}`;
    return { kind: 'login', location: `/auth/github/login?next=${encodeURIComponent(next)}` };
  }
  return { kind: 'ok', client: { clientId: client.clientId, clientName: client.clientName }, redirectUri, state, scope, codeChallenge, who };
}

export function denyLocation(redirectUri: string, state: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set('error', 'access_denied');
  if (state) target.searchParams.set('state', state);
  return target.toString();
}
