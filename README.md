# release-log-hub

**release-log** turns a GitHub repository into a release log. The releases are
plain JSON files in the repo — `release-log.json`, `releases/*.json` and a
`media/` folder — so the source of truth is version-controlled, reviewable and
yours. The service indexes those files and serves them as a public JSON API,
plus a web page for readers.

Three ways to write a release:

- **Over MCP.** The built-in MCP server exposes `list_logs`, `get_log`,
  `get_release`, `create_log`, `write_release`, `publish_release`,
  `unpublish_release` and `add_media`. Point Claude or any MCP client at
  `/mcp`, let it draft the release from the commits, and it commits to the repo
  the same way a human would.
- **In the editor.** A block editor for headline, paragraphs, an image and the
  list of changes. Saving commits against the blob SHA that was last read, so
  two writers never silently overwrite each other.
- **In the repo.** Edit the JSON and push. The service picks the change up.

```bash
npm run dev       # Nuxt with a fake GitHub from logs/demo, http://localhost:3000/api/dev/login
npm test          # node --test, no arguments, from the repository root
npm run typecheck
npm run build     # Nuxt build into web/.output
npm start         # the built service: Nuxt with the core embedded (PORT, default 3000)
npm run start:core  # the core alone, without the interface, for tests and machine clients
```

### Layout

Nuxt (`web/`) is the only interface and embeds the core (`server.ts`, `lib/`)
in the same process. What humans see is rendered by Nuxt; what machines speak
is answered by the core, unchanged (`web/server/utils/corePaths.ts`):

| Core | Nuxt |
|---|---|
| `/health`, `/webhook`, `/mcp`, `/me`, `/auth/*`, `/.well-known/*`, `/upload/*` | `/dashboard`, `/dashboard/logs/<id>`, release editor, `/konto` |
| `/oauth/register`, `/oauth/token`, `POST /oauth/authorize` | `GET /oauth/authorize` (consent), `/anmeldung` |
| `/l/<id>/versions`, `/l/<id>/releases…`, `/l/<id>/media/…` | `/l/<id>`, `/l/<id>/r/<version>` |
| | `/api/*` — the page API from `lib/api/` |
| | `/` — marketing page; with a session, its buttons lead to the dashboard |

`OPEN_SIGNUP=1` (optional) opens signup: every GitHub account may sign in and
the allowlist is no longer consulted. Without the variable the allowlist
applies as before, and without an entry nobody gets in except the accounts in
`ADMIN_LOGINS`.

The interface speaks German and English. The language lives in the `rl_lang`
cookie; without a cookie `Accept-Language` decides, and without a matching
language it is German. The strings live in `web/app/i18n/de.ts` and `en.ts` --
`de.ts` is the source of truth, `en.ts` is type-checked against it, and
`messages.test.ts` keeps both on the same set of keys. The machine-facing
surface is untouched: the section labels in the JSON (`lib/sections.ts`) stay
German, and the interface translates them through the stable `key`.

`MAX_LOGS_PER_OWNER` (optional, default 10) limits how many logs an account may
keep. The limit counts per repository owner and applies to newly created as
well as adopted repositories. `0` lifts it.

`RL_SHOWCASE_URL` (optional) embeds one log's changelog into the landing page:
the URL of its public page, `https://<host>/l/<id>`, from another instance too.
If it is missing or the source does not answer, the landing page appears
without that section. The result is cached for five minutes.

Nuxt reads the migrations from `MIGRATIONS_DIR` (default `./drizzle`, relative
to the working directory): in the bundled server, `import.meta.url` no longer
points next to `drizzle/`.

`npm run dev` sets `RL_DEV_FAKE=1`: the core runs against a fake GitHub from
`logs/demo`, and `/api/dev/login?as=admin` signs in without GitHub. Neither
exists in the production build (`import.meta.dev`).

| Route | Response |
|---|---|
| `/health` | `{"status":"ok"}` |
| `/l/<id>/versions` | Every version with date, title and link |
| `/l/<id>/releases?page=&per_page=` | Feed with per-section counts, 100 per page at most |
| `/l/<id>/releases/<version>` | One version with all entries |
| `/l/<id>/media/<path>` | Images a version refers to |

A log is a directory under `LOGS_ROOT` holding `release-log.json`,
`releases/*.json` and `media/`. The public identifier is the `id` in
`release-log.json`, not the directory name.

`covered` appears in no response: it is bookkeeping, not content.

## Building the index from GitHub

```bash
npm run reindex -- <owner>/<repo> [...]
```

Reads each named repository through the installed GitHub App and writes its log
index into the SQLite database (`DB_PATH`, default
`./data/release-log.sqlite`). The values come from `.env` — the script reads
the file itself when it finds one. `readConfig` requires four environment
variables:

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID` | The app ID of the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Its private key, PEM, base64-encoded |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret of the app |
| `BASE_URL` | The public base URL of the service |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes, hex- or base64-encoded: encrypts the GitHub user tokens (`openssl rand -hex 32`) |

## Operating it

The service reconciles itself. Two triggers start the same function:

- **Webhook.** `POST /webhook`, signed with `GITHUB_WEBHOOK_SECRET`. A delivery
  without a valid signature is dropped before its body is read. The service
  answers 202 immediately; the reconcile runs afterwards.
- **Reconcile.** Every five minutes, the log with the oldest `indexed_at`, plus
  every log that has not been indexed for more than an hour. Frozen logs are
  included — that is the only way a log thaws once its repository comes back.

A lost webhook therefore costs one reconcile round at most. The reconcile
compares git blob SHAs, not an event log: "the webhook never arrived" and
"rebuild the index from zero" are the same case.

| Variable | Meaning |
|---|---|
| `DB_PATH` | Path of the SQLite file, default `./data/release-log.sqlite` |
| `PORT` | Port of the service, default 8787 |
| `GITHUB_CLIENT_ID` | Client ID of the GitHub App, for signing in |
| `GITHUB_CLIENT_SECRET` | Client secret of the GitHub App, for signing in |
| `SIGNING_KEY` | Signs the session cookie |
| `ADMIN_LOGINS` | GitHub logins with admin rights, comma-separated — at least one is required |

`GET /health` answers 200 without touching the index.

### Signing in

- `GET /auth/github/login` redirects to GitHub.
- `GET /auth/github/callback` (registered with GitHub as the callback URL)
  receives the answer, checks the allowlist, sets a session cookie on success
  (30 days) and redirects to the dashboard. If signing in fails, it goes to
  `/anmeldung?fehler=state|github|denied`.
- `POST /auth/logout` deletes the cookie.
- `GET /me` answers `{login, isAdmin}` for a valid session, otherwise 401. The
  account page for humans is `/konto` (Nuxt).
- `GET /` redirects to the dashboard.

Admin rights come from `ADMIN_LOGINS` and nowhere else — there is no database
column for them. Everyone else who is allowed in sits in the `allowlist` table;
admins manage it under `/konto`.

### Repository rights

Whether an account has write access to the repository behind a log is checked
against GitHub and cached for five minutes per (account, log). The cache is
invalidated earlier when `member`, `installation_repositories` or
`installation` arrives — a membership or installation change can affect exactly
that right. A transfer or deletion of the repository (through the `repository`
event, which only triggers the content reconcile) does not: a cached "yes" can
survive such an event by up to five minutes, the same five-minute ceiling as
everywhere else.

### Dashboard

Nuxt pages over the page API (`/api/*`, session cookie, JSON). The rules live
in `lib/api/`:

- `/dashboard` — the logs the signed-in account may write to (frozen ones
  additionally for admins). "New log" creates a repository through the same
  path as `create_log`.
- `/dashboard/logs/<id>` — status, reconcile errors, releases, settings
  (`view`, `visibility`, `curation_notes` as a commit on `release-log.json`,
  never as a database write), media upload (`.png`, `.jpg`, `.webp`, 10 MB at
  most, creates, never replaces) and permanent deletion by typing the product
  name.
- `/dashboard/logs/<id>/releases/new`, `…/releases/<version>` — the release
  editor (Editor.js): headline, paragraphs, one image and the changes as
  blocks. Saving commits through the same path as `write_release`, against the
  blob SHA that was last read; if the release has changed since, nothing is
  overwritten. Publish and unpublish sit next to it. The editor never touches
  `covered` and `commits`.
- `/konto` — profile, disconnecting connected MCP clients, the allowlist
  (admins).

Mutating `/api` calls require `content-type: application/json` (upload:
`x-filename`); with `SameSite=Lax` no foreign page can trigger them.

### MCP and OAuth

A dedicated OAuth 2.0 authorization server (spec §5, "role 2") protects `/mcp`:

- `POST /oauth/register` — Dynamic Client Registration (RFC 7591), public
  clients only (no secret, PKCE `S256` is mandatory).
- `GET /oauth/authorize` — consent screen (Nuxt), `POST` redeems the decision
  in the core. Both check through `lib/oauthRequest.ts`.
- `POST /oauth/token` — `authorization_code` and `refresh_token` grant.
- `GET /.well-known/oauth-protected-resource/mcp`,
  `GET /.well-known/oauth-authorization-server` — metadata (RFC 9728/8414).
- Viewing and disconnecting connected clients: `/konto`.
- `POST /mcp` — the MCP surface itself, Streamable HTTP, bearer token required:
  `list_logs`, `get_log`, `get_release` (scope `logs:read`), `create_log`,
  `write_release`, `publish_release`, `unpublish_release`, `add_media` (scope
  `logs:write`).
- `PUT /upload/<token>` — the image path of `add_media`. The token in the URL
  is the entire credential: single-use, valid for ten minutes, bound to log,
  target path and account. On upload the route checks again whether that
  account may still write, limits to 10 MB and creates the file instead of
  replacing an existing one (`path_exists`, since otherwise a new image would
  silently change every published release pointing at it).

This way image data never touches the agent's context — 5 MB would come to
roughly 6.7 MB of text as base64.

### Creating repositories and the GitHub user token

`create_log` is the one path in this service that does not run on the
installation token: `POST /user/repos` exists only for user tokens. The service
therefore keeps the user token from signing in, per account — **encrypted**
with `TOKEN_ENCRYPTION_KEY`, not hashed, because it is used and not merely
checked. That makes it the only secret in the system a database theft captures
in usable form.

- A refresh revokes the old access token immediately, so its result replaces
  both tokens in one write.
- Refreshes are serialized per account: two concurrent ones revoke each other.
- If the refresh fails, `create_log` answers `reauth_required` and names the
  sign-in URL. The human signs in once more.

Creating runs on the user token, writing on the installation token: first the
repository, then the reachability check (`repo_not_installed` if the app cannot
see the fresh repository), then `release-log.json` and `README.md`, then the
reconcile. The answer comes only once the log is in the index.

### The hosted page

- `/l/<id>` — Nuxt, server-rendered as a timeline: version and date on the
  left, sections (Wichtig, Neu, Änderungen, Behoben) to expand. `timeline`
  opens the first section per release, `full` opens all of them. Drafts only
  for signed-in accounts with write access; private logs carry `noindex` and
  answer everyone else with a 404, like a missing log.
- `/l/<id>/r/<version>` — permalink to a single version.

The public JSON feed (`/l/<id>/versions`, `/l/<id>/releases`, …) and the media
download stay in the core.
