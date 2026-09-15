// Der User-to-Server-Flow der GitHub App (spec §5, Rolle 1): einen
// Autorisierungscode gegen die Identität der Person tauschen, die sich
// gerade anmeldet.
//
// Das dabei entstehende Nutzer-Token wird hier einmal benutzt, um GET /user
// zu fragen, und danach an den Aufrufer weitergereicht -- verschlüsselt
// gespeichert wird es erst dort (lib/userTokens.ts), für den einen Zweck,
// den Entscheidung 23 benennt: POST /user/repos in create_log. Jeder andere
// Repo-Zugriff läuft weiterhin über die Installation.

import type { Http } from './http.ts';
import type { UserTokenSet } from './userTokens.ts';

export type GithubIdentity = { id: number; login: string; avatarUrl: string | null };

export type Login = { identity: GithubIdentity; tokens: UserTokenSet };

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

// Sekunden ab jetzt in einen Zeitpunkt. Fehlen sie, gibt es keinen Ablauf:
// eine App mit abgeschalteten Ablaufzeiten liefert weder expires_in noch
// ein Refresh-Token, und beides ist dann auch nicht nötig.
function expiryOf(nowMs: number, seconds: number | undefined): string | null {
  return typeof seconds === 'number' ? new Date(nowMs + seconds * 1000).toISOString() : null;
}

export async function exchangeCodeForLogin(
  http: Http,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  nowMs: () => number = Date.now,
): Promise<Login | null> {
  const tokenRes = await http('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) return null;
  const tokenBody = (await tokenRes.json()) as TokenResponse;
  if (typeof tokenBody.access_token !== 'string') return null;

  const userRes = await http('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'release-log-hub',
      authorization: `Bearer ${tokenBody.access_token}`,
    },
  });
  if (!userRes.ok) return null;
  const userBody = (await userRes.json()) as { id?: number; login?: string; avatar_url?: string | null };
  if (typeof userBody.id !== 'number' || typeof userBody.login !== 'string') return null;

  const now = nowMs();
  return {
    identity: { id: userBody.id, login: userBody.login, avatarUrl: userBody.avatar_url ?? null },
    tokens: {
      accessToken: tokenBody.access_token,
      accessExpiresAt: expiryOf(now, tokenBody.expires_in),
      refreshToken: typeof tokenBody.refresh_token === 'string' ? tokenBody.refresh_token : null,
      refreshExpiresAt: expiryOf(now, tokenBody.refresh_token_expires_in),
    },
  };
}
