import { log } from '../db/schema.ts';
import { checkAuthorizeRequest } from '../oauthRequest.ts';
import type { LoggedIn } from '../access.ts';
import type { Core, Reply } from './core.ts';
import { ok } from './core.ts';

// Was die Zustimmungsseite zeigt. Die Liste der betroffenen Logs ist reine
// Auskunft; durchgesetzt wird live gegen GitHub bei jedem Werkzeugaufruf.
export async function consent({ auth }: Core, who: LoggedIn | null, search: string): Promise<Reply> {
  const check = checkAuthorizeRequest(auth, 'GET', new URLSearchParams(search), search, who);
  if (check.kind !== 'ok') return ok(check);
  const rows = auth.db.select().from(log).all();
  const writable = await Promise.all(rows.map((row) =>
    auth.perms.canWrite(check.who.accountId, check.who.login, row.publicId, { owner: row.repoOwner, repo: row.repoName })));
  return ok({
    kind: 'ok',
    clientName: check.client.clientName,
    scope: check.scope,
    logs: rows.filter((_, i) => writable[i]).map((row) => ({ product: row.product, repo: `${row.repoOwner}/${row.repoName}` })),
    form: {
      client_id: check.client.clientId, redirect_uri: check.redirectUri, code_challenge: check.codeChallenge,
      code_challenge_method: 'S256', state: check.state, scope: check.scope,
    },
  });
}
