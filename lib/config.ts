// Read once, at startup, and fail with every problem at once. A service
// that starts and then discovers its third missing variable on the first
// request wastes a deploy cycle per variable.

export type AppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  baseUrl: string;
};

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'BASE_URL',
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

  return {
    appId: env.GITHUB_APP_ID as string,
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET as string,
    baseUrl: env.BASE_URL as string,
  };
}
