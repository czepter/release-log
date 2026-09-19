# Self-hosting release-log

One process, one SQLite file, one GitHub App. The releases themselves live in
your users' repositories, so this service stores no content worth protecting
except the index it can rebuild and the encrypted GitHub user tokens.

- [What you need](#what-you-need)
- [1. Create the GitHub App](#1-create-the-github-app)
- [2. Generate the secrets](#2-generate-the-secrets)
- [3. Pick a deployment method](#3-pick-a-deployment-method)
  - [Docker Compose](#docker-compose)
    - [Building on a small server](#building-on-a-small-server)
  - [Coolify](#coolify)
  - [Railway, Railpack and friends](#railway-railpack-and-friends)
  - [Dokku and CapRover](#dokku-and-caprover)
  - [Bare Node with systemd](#bare-node-with-systemd)
- [4. Finish the GitHub App](#4-finish-the-github-app)
- [Reverse proxy](#reverse-proxy)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)

## What you need

- A public HTTPS URL. GitHub has to reach `/webhook`, and the OAuth callback
  has to come back to the same host. Neither works on `localhost`.
- A GitHub App. Not an OAuth App: the service signs in humans *and* reads
  repositories through an installation, and only a GitHub App does both.
- Persistent disk for one SQLite file. A few megabytes; it grows with the
  number of releases indexed, not with images.
- Node 24.2 or newer, if you are not using the container image.
- RAM. Running the service takes little; *building* it does not. The Vite
  client build peaks well above 2 GB, and a host with less kills it with
  exit 137. See [Building on a small
  server](#building-on-a-small-server).

There is no second service. No Redis, no Postgres, no object storage, no cron
container: the reconcile loop is a timer inside the same process.

## 1. Create the GitHub App

Under **Settings -> Developer settings -> GitHub Apps -> New GitHub App**.
Some of these fields need the public URL, so decide on it now; you can correct
them afterwards, and step 4 asks you to.

| Field | Value |
|---|---|
| Homepage URL | `https://releases.example.com` |
| Callback URL | `https://releases.example.com/auth/github/callback` |
| Request user authorization (OAuth) during installation | on |
| Expire user authorization tokens | either; the service handles both |
| Webhook URL | `https://releases.example.com/webhook` |
| Webhook secret | a random string, kept for `GITHUB_WEBHOOK_SECRET` |

Repository permissions:

| Permission | Level | Why |
|---|---|---|
| Metadata | Read | Mandatory for every app |
| Contents | Read and write | Reads `release-log.json`, `releases/*.json` and `media/`, and commits what the editor and the MCP tools write |
| Administration | Read and write | `create_log` calls `POST /user/repos` on the user token, and the write-access check reads the collaborator permission |

Subscribe to these events: **Push**, **Repository**, **Member**. The two
installation events arrive whether you tick them or not.

Then **Generate a private key** — a `.pem` file downloads once — and note the
**App ID**, **Client ID** and a freshly generated **Client secret**.

Finally install the app, on your own account or an organisation. Only
repositories the app is installed on can ever become logs.

## 2. Generate the secrets

```bash
cp .env.example .env
openssl rand -hex 32                      # SIGNING_KEY
openssl rand -hex 32                      # TOKEN_ENCRYPTION_KEY
base64 -w0 your-app.private-key.pem       # GITHUB_APP_PRIVATE_KEY  (macOS: base64 -i)
```

The private key is stored base64-encoded because a multi-line PEM is not an
environment variable. `TOKEN_ENCRYPTION_KEY` encrypts the GitHub user tokens at
rest; it is the one secret whose loss is not merely inconvenient, because
changing it makes every stored token unreadable and every human has to sign in
again.

`ADMIN_LOGINS` takes at least one GitHub login. Admin rights come from that
variable and nowhere else, which is what keeps an empty allowlist from locking
everyone out for good. Set `OPEN_SIGNUP=1` if the allowlist is not the point of
your instance.

The service reads its configuration once, at startup, and names every missing
variable in one error. A start that fails with
`missing environment variables: ...` has not written anything.

## 3. Pick a deployment method

Every method runs the same thing: `node web/.output/server/index.mjs`, with
`DB_PATH` on a persistent volume.

### Docker Compose

```bash
cp .env.example .env    # fill it in
docker compose up -d --build
curl -fsS http://localhost:3000/health    # {"ok":true}
```

`docker-compose.yml` builds the image from this repository, publishes port
3000 and keeps the database in the named volume `release-log-data`. Put your
own TLS terminator in front of it; see [Reverse proxy](#reverse-proxy).

The image is two stages. The build stage compiles the Nuxt output and carries
the C toolchain, because `better-sqlite3` falls back to compiling from source
when its install script cannot fetch a prebuilt binary. The runtime stage
carries nothing but `web/.output`, the migrations and Node: Nitro bundles every
dependency, the compiled SQLite binding included, into
`web/.output/server/node_modules`. That makes the runtime image small and
compiler-free, and it makes it architecture-specific — build it where you run
it, or use `docker buildx --platform`.

Without Compose:

```bash
docker build -t release-log:1.0.0 .
docker run -d --name release-log \
  --env-file .env \
  -v release-log-data:/data \
  -p 3000:3000 \
  release-log:1.0.0
```

#### Building on a small server

`docker compose up --build` on a 2 GB box ends in `exit code: 137`. That is the
kernel's OOM killer taking out the Vite client build, not a configuration
error, and no Node flag helps: Vite 8 builds through Rolldown, so the peak is
native memory outside V8's heap.

Three ways around it, in the order of how little work they are:

1. **Pull the image instead of building it.** The `image` workflow in
   `.github/workflows/docker.yml` builds `linux/amd64` and `linux/arm64` on a
   runner of each architecture and pushes a manifest list to GHCR on every
   `v*` tag. Then drop the `build:` key and
   name the image:

   ```yaml
   services:
     release-log:
       image: ghcr.io/<owner>/release-log:1.0.0
   ```

2. **Build elsewhere and push.** `docker buildx build --platform linux/amd64
   -t <registry>/release-log:1.0.0 --push .` from a machine that has the RAM.
3. **Add swap.** Slow, but it does finish, and a build server only needs it
   during the build.

### Coolify

Two ways in; the second is the one most people want.

**As a Docker Compose resource.** New Resource -> Docker Compose, point it at
`docker-compose.coolify.yml`. The file declares
`SERVICE_FQDN_RELEASELOG_3000`, so Coolify generates the domain, routes port
3000 through its proxy, terminates TLS and fills `BASE_URL` with the result.
The public URL is then configured in exactly one place. Put the GitHub App
secrets into Coolify's environment editor — the compose file refers to them
with `${VAR:?}`, so a missing one fails the deploy instead of starting a
half-configured service.

**As a Dockerfile resource.** New Resource -> Private/Public Repository, build
pack **Dockerfile**, port 3000. Add a persistent volume mounted at `/data`,
set the domain, and set `BASE_URL` to that domain yourself. Everything else is
the same set of variables.

Either way, add the volume before the first deploy. A container without it
starts fine and loses its index on the next one.

Coolify builds on the server it deploys to, so a small node runs into the
memory ceiling described above. Point the compose file at a prebuilt image
there rather than giving the box swap.

### Railway, Railpack and friends

`railpack.json` pins Node 24 and the start command; the rest Railpack infers
(`npm ci`, `npm run build`). It works unchanged on Railway and on anything
else that speaks Railpack.

- Attach a volume and point `DB_PATH` into it, for example
  `/data/release-log.sqlite`. Without a volume the index is gone every deploy,
  and while it does rebuild itself from GitHub, the sessions and the connected
  MCP clients do not.
- Set `BASE_URL` to the generated domain once it exists, then redeploy. The
  callback URL and the webhook URL have to match it.
- `PORT` is injected by the platform; leave it alone.

The container image is an equally good fit there — pick whichever of the two
your platform builds more reliably.

### Dokku and CapRover

Both build the `Dockerfile` in this repository, so there is nothing
release-log-specific to configure beyond the variables and the volume.

```bash
# Dokku, on the server
dokku apps:create release-log
dokku storage:ensure-directory release-log
dokku storage:mount release-log /var/lib/dokku/data/storage/release-log:/data
dokku config:set release-log BASE_URL=https://releases.example.com DB_PATH=/data/release-log.sqlite ...
dokku ports:set release-log http:80:3000
dokku letsencrypt:enable release-log
# then: git remote add dokku dokku@server:release-log && git push dokku main
```

On CapRover: captain-definition with `"dockerfilePath": "./Dockerfile"`,
container port 3000, a persistent directory mounted at `/data`, the variables
under App Configs.

### Bare Node with systemd

```bash
git clone https://github.com/<you>/release-log.git /srv/release-log
cd /srv/release-log
npm ci
npm run build
cp .env.example .env    # fill it in; DB_PATH=/srv/release-log/data/release-log.sqlite
npm start
```

`npm start` is `node --env-file-if-exists=.env web/.output/server/index.mjs`,
so the `.env` file is read without any extra tooling. Outside a container,
`MIGRATIONS_DIR` can stay unset as long as the working directory is the
repository root.

```ini
# /etc/systemd/system/release-log.service
[Unit]
Description=release-log
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=release-log
WorkingDirectory=/srv/release-log
ExecStart=/usr/bin/node --env-file-if-exists=.env web/.output/server/index.mjs
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# The .env file holds every secret; nothing else needs to read it.
UMask=0077

[Install]
WantedBy=multi-user.target
```

`npm run start:core` starts the core alone, without the interface. It answers
the machine-facing routes and nothing else, which is useful for a smoke test
and for nothing in production.

## 4. Finish the GitHub App

Once the service has a real URL, go back to the app's settings and make three
things agree, because a mismatch fails quietly in three different ways:

| Setting | Must equal |
|---|---|
| `BASE_URL` | the public URL, no trailing slash |
| Callback URL | `<BASE_URL>/auth/github/callback` |
| Webhook URL | `<BASE_URL>/webhook` |

Then check it end to end:

```bash
curl -fsS https://releases.example.com/health      # {"ok":true}
```

Sign in at `/anmeldung` with an account named in `ADMIN_LOGINS`, and push a
commit to a repository the app is installed on — the delivery shows up under
the app's **Advanced -> Recent Deliveries** with a 202.

A lost webhook is not an outage. The reconcile loop runs every five minutes
over the log with the oldest `indexed_at` plus everything older than an hour,
and it compares git blob SHAs rather than replaying events, so "the webhook
never arrived" and "rebuild from zero" are the same case. If you want to force
one:

```bash
npm run reindex -- owner/repo
```

## Reverse proxy

Coolify, Dokku and the PaaS options bring their own. If you terminate TLS
yourself, the service needs nothing but a plain proxy pass — no path rewriting,
no special headers, no websocket upgrade.

```caddy
releases.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

```nginx
server {
    listen 443 ssl http2;
    server_name releases.example.com;
    # ssl_certificate ...;

    client_max_body_size 12M;   # media upload is capped at 10 MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The 12 MB body limit is the only setting worth getting right: `add_media` and
the dashboard upload accept images up to 10 MB, and nginx's default of 1 MB
rejects them before the service sees them.

## Backups

One file, and its two sidecars while the service runs:

```bash
sqlite3 /data/release-log.sqlite ".backup '/backup/release-log-$(date +%F).sqlite'"
```

Use `.backup`, not `cp`: SQLite runs in WAL mode here, and a plain copy of the
`.sqlite` file without its `-wal` is a torn backup.

What is in there: the log index, sessions, the allowlist, OAuth clients and
tokens, and the GitHub user tokens encrypted with `TOKEN_ENCRYPTION_KEY`. What
is not: any release content you cannot get back. Every release, every image
and every setting is a commit in a GitHub repository, and a fresh database
rebuilds itself from those within one reconcile round. Losing the database
costs sessions and connected MCP clients, not content.

Back up `TOKEN_ENCRYPTION_KEY` with the database or neither is worth much.

## Upgrading

```bash
git pull
docker compose up -d --build     # or: npm ci && npm run build && systemctl restart release-log
```

Migrations run at startup, from `MIGRATIONS_DIR`. They are additive; the
service applies what is missing and starts. Take the backup before the restart,
not after.

## Troubleshooting

**`missing environment variables: ...`** — exactly what it says, every missing
one at once. Nothing has started.

**`GITHUB_APP_PRIVATE_KEY does not decode to a PEM PRIVATE KEY block`** — the
variable holds the PEM itself instead of its base64, or the base64 got wrapped
over several lines. Use `base64 -w0`.

**`ADMIN_LOGINS must name at least one GitHub login`** — the variable is set
but trims to nothing. That is the same lockout it exists to prevent, so it
fails at startup rather than at the first denied login.

**Migrations not found** — the bundled server does not sit next to `drizzle/`,
so it cannot guess. Set `MIGRATIONS_DIR` to the absolute path of the folder;
the container image sets `/app/drizzle` for you.

**Webhook deliveries show 401** — `GITHUB_WEBHOOK_SECRET` does not match the
app's. An unsigned or wrongly signed delivery is dropped before its body is
read, which is why the error carries nothing more specific.

**Sign-in ends at `/anmeldung?fehler=state`** — the callback came back to a
different host than the one that started it. `BASE_URL` and the app's callback
URL disagree, or a proxy is rewriting the host.

**Sign-in works but the dashboard is empty** — the account is not in
`ADMIN_LOGINS` and not on the allowlist, or the app is not installed on any
repository that has a `release-log.json`.

**`repo_not_installed` right after creating a log** — the repository was
created on the user token, but the installation cannot see it yet. Installing
the app on *all* repositories of that account, rather than a hand-picked list,
removes the case entirely.
