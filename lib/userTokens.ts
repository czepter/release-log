// Das GitHub-Nutzer-Token je Konto (spec §5, Entscheidung 23). Es existiert
// für genau einen Zweck: `POST /user/repos` gibt es nur für Nutzer-Token,
// nicht für Installations-Token, also kann `create_log` nicht über die
// Installation laufen. Jeder andere Repo-Zugriff dieses Diensts tut das
// weiterhin.
//
// Zwei Anforderungen sieht man dem Ablauf nicht an, und beide stehen hier
// im Code, nicht nur im Entwurf:
//
//   - Ein Refresh widerruft das alte Access-Token SOFORT. Das Ergebnis
//     ersetzt deshalb beide Token in EINEM Schreibvorgang; ein halb
//     geschriebener Datensatz ließe das alte Token widerrufen und das neue
//     ungespeichert zurück -- das Konto wäre ausgesperrt.
//   - Zwei gleichzeitige Refreshes widerrufen einander. Sie laufen deshalb
//     je Konto serialisiert: der zweite Aufrufer bekommt das Versprechen
//     des ersten, nicht einen zweiten Refresh. Genau das passiert nach
//     einer längeren Pause, wenn mehrere Aufrufe zugleich eintreffen -- der
//     wahrscheinlichste Moment, nicht der unwahrscheinlichste.

import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { githubUserToken } from './db/schema.ts';
import type { Http } from './http.ts';
import type { Cipher } from './secrets.ts';

// Ein Token, das in weniger als einer Minute abläuft, gilt als abgelaufen:
// es könnte mitten in der Anfrage sterben, die es gerade trägt.
const EXPIRY_MARGIN_MS = 60_000;

export type UserTokenSet = {
  accessToken: string;
  // null heißt "läuft nicht ab" -- der Fall, wenn in der App "Expire user
  // authorization tokens" abgeschaltet ist. Dann gibt es auch kein
  // Refresh-Token, und es wird keins gebraucht.
  accessExpiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
};

export type UserTokenResult =
  | { ok: true; token: string }
  // reauth_required: der Mensch meldet sich einmal neu an, mehr ist nicht
  // zu tun. github_unavailable: es lag nicht am Token, gleich noch mal.
  | { ok: false; error: 'reauth_required' | 'github_unavailable' };

export type UserTokens = {
  store(accountId: number, tokens: UserTokenSet): void;
  tokenFor(accountId: number): Promise<UserTokenResult>;
  forget(accountId: number): void;
};

export type UserTokenDeps = {
  db: Db;
  http: Http;
  cipher: Cipher;
  clientId: string;
  clientSecret: string;
  nowMs?: () => number;
};

type RefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
};

function expiryOf(nowMs: number, seconds: number | undefined): string | null {
  return typeof seconds === 'number' ? new Date(nowMs + seconds * 1000).toISOString() : null;
}

export function userTokens(deps: UserTokenDeps): UserTokens {
  const { db, http, cipher, clientId, clientSecret } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  // Je Konto höchstens ein laufender Refresh. Der Eintrag verschwindet,
  // sobald er fertig ist -- der Cache ist die Serialisierung, nicht ein
  // Zwischenspeicher für das Ergebnis.
  const refreshing = new Map<number, Promise<UserTokenResult>>();

  function store(accountId: number, tokens: UserTokenSet): void {
    const row = {
      accountId,
      accessTokenEnc: cipher.encrypt(tokens.accessToken),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshTokenEnc: tokens.refreshToken === null ? null : cipher.encrypt(tokens.refreshToken),
      refreshExpiresAt: tokens.refreshExpiresAt,
      updatedAt: new Date(nowMs()).toISOString(),
    };
    // Ein Schreibvorgang für beide Token -- siehe der Kommentar oben.
    db.insert(githubUserToken).values(row)
      .onConflictDoUpdate({ target: githubUserToken.accountId, set: row })
      .run();
  }

  function forget(accountId: number): void {
    db.delete(githubUserToken).where(eq(githubUserToken.accountId, accountId)).run();
  }

  async function refresh(accountId: number, refreshToken: string): Promise<UserTokenResult> {
    const res = await http('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId, client_secret: clientSecret,
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    });
    // Ein Netz- oder Serverfehler ist keine Aussage über das Token: die
    // gespeicherte Erlaubnis bleibt stehen, der Aufrufer versucht es
    // später wieder.
    if (!res.ok) return { ok: false, error: 'github_unavailable' };
    const body = (await res.json()) as RefreshResponse;
    if (typeof body.access_token !== 'string') {
      // GitHub beantwortet ein totes Refresh-Token mit HTTP 200 und einem
      // error-Feld, nicht mit einem Fehlerstatus. Was hier liegt, ist
      // unbrauchbar -- weg damit, sonst kostet jeder weitere Aufruf einen
      // weiteren vergeblichen Umlauf.
      forget(accountId);
      return { ok: false, error: 'reauth_required' };
    }
    const now = nowMs();
    store(accountId, {
      accessToken: body.access_token,
      accessExpiresAt: expiryOf(now, body.expires_in),
      // Der Refresh liefert selbst ein neues Refresh-Token; fehlt es
      // (abgeschaltete Ablaufzeiten), bleibt es bei dem, was wir hatten.
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
      refreshExpiresAt: expiryOf(now, body.refresh_token_expires_in),
    });
    return { ok: true, token: body.access_token };
  }

  return {
    store,
    forget,

    async tokenFor(accountId) {
      // Kein await vor diesem Blick in die Map: die Serialisierung trägt
      // nur, solange zwei Aufrufer im selben Tick denselben Eintrag sehen.
      const pending = refreshing.get(accountId);
      if (pending) return pending;

      const row = db.select().from(githubUserToken).where(eq(githubUserToken.accountId, accountId)).all()[0];
      if (!row) return { ok: false, error: 'reauth_required' };

      const now = nowMs();
      const accessToken = cipher.decrypt(row.accessTokenEnc);
      const accessUsable = accessToken !== null
        && (row.accessExpiresAt === null || Date.parse(row.accessExpiresAt) - EXPIRY_MARGIN_MS > now);
      if (accessUsable) return { ok: true, token: accessToken as string };

      const refreshToken = row.refreshTokenEnc === null ? null : cipher.decrypt(row.refreshTokenEnc);
      const refreshUsable = refreshToken !== null
        && (row.refreshExpiresAt === null || Date.parse(row.refreshExpiresAt) > now);
      if (!refreshUsable) return { ok: false, error: 'reauth_required' };

      const run = refresh(accountId, refreshToken as string)
        .finally(() => { refreshing.delete(accountId); });
      refreshing.set(accountId, run);
      return run;
    },
  };
}
