// Der User-to-Server-Flow der GitHub App (spec §5, Rolle 1): einen
// Autorisierungscode gegen die Identität der Person tauschen, die sich
// gerade anmeldet. Das dabei entstehende Nutzer-Token wird genau hier,
// genau einmal benutzt, um GET /user zu fragen -- und dann nie wieder
// angefasst. Jeder andere Repo-Zugriff läuft über die Installation
// (spec §5); die einzige, offengelegte Ausnahme ist create_log's
// dauerhaftes, verschlüsseltes Nutzer-Token aus Entscheidung 23, das
// außerhalb dieses Moduls liegt.

import type { Http } from './http.ts';

export type GithubIdentity = { id: number; login: string; avatarUrl: string | null };

export async function exchangeCodeForIdentity(
  http: Http,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GithubIdentity | null> {
  const tokenRes = await http('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) return null;
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
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
  return { id: userBody.id, login: userBody.login, avatarUrl: userBody.avatar_url ?? null };
}
