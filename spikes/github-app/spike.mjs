// Wegwerfcode. Beantwortet die vier offenen Fragen aus Schritt 0 der
// Bauabfolge (docs/superpowers/specs/2026-09-08-release-log-hub-design.md).
// Ergebnis ist eine Antwort, kein Baustein: nichts hier ist zum Weiterbauen
// gedacht, und der Dienst wird davon keine Zeile erben.
//
//   node --env-file=.env spikes/github-app/spike.mjs
//
// Voraussetzung: der Tunnel läuft und zeigt auf denselben Port wie PORT.

import { createServer } from 'node:http';
import { createSign, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const UA = 'release-log-spike';
const findings = [];
const record = (q, verdict, detail) => {
  findings.push({ q, verdict, detail });
  const mark = verdict === 'ja' ? '✓' : verdict === 'nein' ? '✗' : '?';
  console.log(`\n  ${mark} ${q}\n    ${detail}\n`);
};

// ── Umgebung ──────────────────────────────────────────────────────────────
const REQUIRED = [
  'BASE_URL', 'PORT', 'GITHUB_APP_ID', 'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET',
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\n  Fehlende Werte in .env: ${missing.join(', ')}`);
  console.error('  Lauf scripts/setup-github-app.sh (Antwort: dev).\n');
  process.exit(1);
}
const {
  BASE_URL, PORT, GITHUB_APP_ID, GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET, GITHUB_WEBHOOK_SECRET,
} = process.env;

// Der Tunnel entscheidet, welcher Port öffentlich ist. Stimmt PORT nicht mit
// ihm überein, kommt der OAuth-Callback nie an und der Tunnel liefert 502 —
// ein Fehlschlag, der wie ein GitHub-Problem aussieht und keines ist.
try {
  const conf = readFileSync('scripts/cloudflared-release-log-dev.yml', 'utf8');
  const tunnelPort = conf.match(/localhost:(\d+)/)?.[1];
  if (tunnelPort && tunnelPort !== String(PORT)) {
    console.error(`\n  PORT=${PORT} in .env, aber der Tunnel zeigt auf ${tunnelPort}.`);
    console.error('  Der Callback käme nie an. Korrigieren:');
    console.error(`    sed -i '' 's/^PORT=.*/PORT=${tunnelPort}/' .env\n`);
    process.exit(1);
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.error('\n  Tunnel-Konfiguration nicht gefunden — läuft scripts/setup-tunnel.sh?\n');
  process.exit(1);
}

const PRIVATE_KEY = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, 'base64').toString('utf8');
if (!PRIVATE_KEY.includes('PRIVATE KEY')) {
  console.error('\n  GITHUB_APP_PRIVATE_KEY ist nach base64-Dekodierung kein PEM.\n');
  process.exit(1);
}

// ── GitHub-Aufrufe ────────────────────────────────────────────────────────
async function gh(path, { token, tokenType = 'Bearer', method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `${tokenType} ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

// App-JWT von Hand: RS256 über header.payload. Keine Abhängigkeit für 10 Zeilen.
function appJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const payload = b64({ iat: now - 60, exp: now + 540, iss: GITHUB_APP_ID });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${payload}`);
  return `${head}.${payload}.${signer.sign(PRIVATE_KEY, 'base64url')}`;
}

// ── Kleiner Server: OAuth-Rückweg und Webhook-Empfang ─────────────────────
const state = randomUUID();
let resolveCode;
const codePromise = new Promise((r) => { resolveCode = r; });
const webhooks = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/auth/github/callback') {
    const code = url.searchParams.get('code');
    const got = url.searchParams.get('state');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (got !== state) {
      res.end('<h1>state passt nicht</h1><p>Abgebrochen. Zurueck zum Terminal.</p>');
      return;
    }
    res.end('<h1>Danke</h1><p>Zurueck zum Terminal.</p>');
    resolveCode(code);
    return;
  }

  if (url.pathname === '/webhook' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sent = req.headers['x-hub-signature-256'] || '';
      const mine = 'sha256=' + createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(raw).digest('hex');
      const a = Buffer.from(sent), b = Buffer.from(mine);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      webhooks.push({ event: req.headers['x-github-event'], ok, bytes: raw.length });
      res.writeHead(ok ? 204 : 401).end();
    });
    return;
  }

  res.writeHead(404).end();
});
await new Promise((r) => server.listen(Number(PORT), '127.0.0.1', r));
console.log(`\n  Spike läuft auf Port ${PORT}, öffentlich als ${BASE_URL}\n`);

// ── Frage 1: legt ein Nutzer-Token ein Repo auf dem persönlichen Konto an? ─
const authorizeUrl = `https://github.com/login/oauth/authorize`
  + `?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}`
  + `&redirect_uri=${encodeURIComponent(`${BASE_URL}/auth/github/callback`)}`
  + `&state=${state}`;

console.log('  Öffne im Browser und bestätige:\n');
console.log(`    ${authorizeUrl}\n`);

const code = await Promise.race([
  codePromise,
  new Promise((_, rej) => setTimeout(() => rej(new Error('kein Callback binnen 180s')), 180_000)),
]);

const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
  method: 'POST',
  headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
  body: JSON.stringify({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: `${BASE_URL}/auth/github/callback`,
  }),
});
const tok = await tokenRes.json();
if (!tok.access_token) {
  record('Nutzer-Token erhalten?', 'nein', `Antwort: ${JSON.stringify(tok)}`);
  process.exit(1);
}
const userToken = tok.access_token;
record(
  'Callback erreichbar und Nutzer-Token erhalten?', 'ja',
  `expires_in=${tok.expires_in ?? 'nie'}, refresh_token=${tok.refresh_token ? 'ja' : 'nein'}`
    + `\n    Ablaufende Token sind die Voraussetzung von Entscheidung 23.`,
);

// Refresh sofort einmal ausprobieren: trägt der Zyklus?
if (tok.refresh_token) {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
    }),
  });
  const rj = await r.json();
  record(
    'Trägt der Refresh-Zyklus?',
    rj.access_token ? 'ja' : 'nein',
    rj.access_token
      ? `neues Token erhalten, refresh_token_expires_in=${rj.refresh_token_expires_in ?? '?'}`
      : `Antwort: ${JSON.stringify(rj)}`,
  );
}

const me = await gh('/user', { token: userToken });
const login = me.json?.login;
const repoName = `release-log-spike-${Date.now()}`;

const created = await gh('/user/repos', {
  token: userToken,
  method: 'POST',
  body: { name: repoName, private: true, auto_init: true, description: 'Wegwerf-Repo aus dem Spike' },
});
record(
  'Legt ein Nutzer-Token ein Repo auf dem persönlichen Konto an?',
  created.status === 201 ? 'ja' : 'nein',
  created.status === 201
    ? `${login}/${repoName} angelegt (HTTP 201)`
    : `HTTP ${created.status}: ${created.json?.message ?? created.text.slice(0, 200)}`,
);
if (created.status !== 201) { server.close(); process.exit(1); }

// ── Installations-Token besorgen ──────────────────────────────────────────
const installs = await gh('/app/installations', { token: appJwt() });
const install = installs.json?.find((i) => i.account?.login?.toLowerCase() === login.toLowerCase());
if (!install) {
  record('Installation gefunden?', 'nein',
    `Keine Installation für ${login}. Installiere die App auf deinem Konto.`);
  server.close(); process.exit(1);
}
const itRes = await gh(`/app/installations/${install.id}/access_tokens`, { token: appJwt(), method: 'POST' });
const instToken = itRes.json?.token;
record('Installations-Token erhalten?', instToken ? 'ja' : 'nein',
  instToken
    ? `Installation ${install.id}, repository_selection=${install.repository_selection}`
    : `HTTP ${itRes.status}: ${itRes.json?.message}`);
if (!instToken) { server.close(); process.exit(1); }

// Bei "selected" ist ein frisch angelegtes Repo NICHT automatisch dabei.
const reach = await gh(`/repos/${login}/${repoName}`, { token: instToken });
record(
  'Erreicht die Installation das neu angelegte Repo?',
  reach.status === 200 ? 'ja' : 'nein',
  reach.status === 200
    ? 'ja — Installations-Token sieht das Repo sofort'
    : `HTTP ${reach.status}. Bei repository_selection=selected muss ein neues Repo`
      + `\n    erst zur Installation hinzugefügt werden. Das ist ein Schritt, den`
      + `\n    create_log kennen muss.`,
);

// ── Frage 2: liefert der Commit die Blob-SHA? ─────────────────────────────
if (reach.status === 200) {
  const put = await gh(`/repos/${login}/${repoName}/contents/releases/0.1.0.json`, {
    token: instToken,
    method: 'PUT',
    body: {
      message: 'spike: erste Release-Datei',
      content: Buffer.from(JSON.stringify({ version: '0.1.0' }, null, 2)).toString('base64'),
    },
  });
  record(
    'Gibt die Contents-API beim Commit die Blob-SHA zurück?',
    put.json?.content?.sha ? 'ja' : 'nein',
    put.json?.content?.sha
      ? `content.sha=${put.json.content.sha}, commit.sha=${put.json.commit?.sha}`
        + `\n    Damit braucht der Write-Through keinen zweiten Aufruf.`
      : `HTTP ${put.status}: ${put.json?.message ?? put.text.slice(0, 200)}`,
  );

  // ── Frage 3: Baum-Abgleich und Rate-Limit ──────────────────────────────
  const tree = await gh(`/repos/${login}/${repoName}/git/trees/HEAD?recursive=1`, { token: instToken });
  const files = (tree.json?.tree ?? []).filter((t) => t.type === 'blob');
  record(
    'Trägt der Baum-Abgleich innerhalb der Rate-Limits?',
    tree.status === 200 ? 'ja' : 'nein',
    `${files.length} Blobs in einem Aufruf, truncated=${tree.json?.truncated}`
      + `\n    Rate-Limit: ${tree.headers.get('x-ratelimit-remaining')} von `
      + `${tree.headers.get('x-ratelimit-limit')} übrig`,
  );
}

// ── Frage 4: kommt der Webhook an und stimmt die Signatur? ────────────────
console.log('  Warte bis zu 45s auf den push-Webhook …\n');
const deadline = Date.now() + 45_000;
while (webhooks.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
}
const push = webhooks.find((w) => w.event === 'push') ?? webhooks[0];
record(
  'Kommen Webhooks am Tunnel an und verifiziert die Signatur?',
  push ? (push.ok ? 'ja' : 'nein') : 'nein',
  push
    ? `Event ${push.event}, ${push.bytes} Bytes, Signatur ${push.ok ? 'gültig' : 'UNGÜLTIG'}`
    : 'Kein Webhook eingetroffen. Prüfe Webhook-URL und ob der Tunnel läuft.',
);

// ── Zusammenfassung ───────────────────────────────────────────────────────
console.log('\n  ── Ergebnis ──────────────────────────────────────────────\n');
for (const f of findings) console.log(`  ${f.verdict.padEnd(5)} ${f.q}`);
console.log(`\n  Wegwerf-Repo: https://github.com/${login}/${repoName}`);
console.log('  Löschen, wenn du fertig bist:');
console.log(`    gh repo delete ${login}/${repoName} --yes\n`);

server.close();
