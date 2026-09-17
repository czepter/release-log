// Read once, at startup, and fail with every problem at once. A service
// that starts and then discovers its third missing variable on the first
// request wastes a deploy cycle per variable.

import { readEncryptionKey } from './secrets.ts';

export type AppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  baseUrl: string;
  // The GitHub App's OAuth identity, distinct from appId: appId signs the
  // app's own JWT, clientId/clientSecret run the user-to-server login flow
  // (spec §5, role 1). Both exist on the same App's settings page.
  clientId: string;
  clientSecret: string;
  // Signs the session cookie. Nothing but this process ever needs to read
  // or write with it.
  signingKey: string;
  // Verschlüsselt die GitHub-Nutzer-Token im Ruhezustand (spec §12).
  // 32 Bytes, hex- oder base64-kodiert -- roh sind sie keine .env-Zeile.
  tokenEncryptionKey: Buffer;
  // Who is allowed to sign in without ever needing a row in the
  // allowlist table — solves the chicken-and-egg problem of an empty
  // table locking everyone out forever (spec §5, decision 15).
  adminLogins: string[];
  // Offene Anmeldung: jedes GitHub-Konto darf sich anmelden, die
  // Zulassungsliste wird gar nicht erst befragt.
  openSignup: boolean;
  // Wie viele Logs ein Konto führen darf. 0 heißt: keine Grenze.
  maxLogsPerOwner: number;
};

// 0 schaltet die Grenze ab; alles andere als eine ganze Zahl ist ein
// Tippfehler und soll beim Start auffallen, nicht beim ersten create_log.
const DEFAULT_MAX_LOGS = 10;

function readMaxLogs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_LOGS;
  if (!/^\d+$/.test(raw.trim())) throw new Error('MAX_LOGS_PER_OWNER must be a whole number (0 turns the limit off)');
  return Number(raw.trim());
}

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'BASE_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SIGNING_KEY',
  'TOKEN_ENCRYPTION_KEY',
  'ADMIN_LOGINS',
];

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = REQUIRED.filter((name) => {
    const value = env[name];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    // Names only. A value here would be a secret in a log line.
    throw new Error(`missing environment variables: ${missing.join(', ')}`);
  }

  // The key is stored base64-encoded because a multi-line PEM is not an
  // .env line (spec §12).
  const privateKey = Buffer.from(env.GITHUB_APP_PRIVATE_KEY as string, 'base64').toString('utf8');
  if (!privateKey.includes('PRIVATE KEY')) {
    throw new Error('GITHUB_APP_PRIVATE_KEY does not decode to a PEM PRIVATE KEY block');
  }

  // Dieselbe Behandlung wie der private Schlüssel: früh und laut
  // scheitern, nicht erst beim ersten create_log.
  const tokenEncryptionKey = readEncryptionKey(env.TOKEN_ENCRYPTION_KEY as string);

  // Optional, mit Vorgabe: eine Instanz ohne diese Variablen verhält sich
  // wie vorher, geschlossen und mit zehn Logs je Konto.
  const openSignup = env.OPEN_SIGNUP === '1' || env.OPEN_SIGNUP === 'true';
  const maxLogsPerOwner = readMaxLogs(env.MAX_LOGS_PER_OWNER as string | undefined);

  const adminLogins = (env.ADMIN_LOGINS as string).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (adminLogins.length === 0) {
    // A non-empty variable that trims down to nothing is the same
    // lockout ADMIN_LOGINS exists to prevent — fail loudly at startup,
    // not silently at the first denied login.
    throw new Error('ADMIN_LOGINS must name at least one GitHub login');
  }

  return {
    appId: env.GITHUB_APP_ID as string,
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET as string,
    baseUrl: env.BASE_URL as string,
    clientId: env.GITHUB_CLIENT_ID as string,
    clientSecret: env.GITHUB_CLIENT_SECRET as string,
    signingKey: env.SIGNING_KEY as string,
    tokenEncryptionKey,
    adminLogins,
    openSignup,
    maxLogsPerOwner,
  };
}
