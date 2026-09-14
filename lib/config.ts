// Read once, at startup, and fail with every problem at once. A service
// that starts and then discovers its third missing variable on the first
// request wastes a deploy cycle per variable.

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
  // Who is allowed to sign in without ever needing a row in the
  // allowlist table — solves the chicken-and-egg problem of an empty
  // table locking everyone out forever (spec §5, decision 15).
  adminLogins: string[];
};

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'BASE_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SIGNING_KEY',
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
    adminLogins,
  };
}
