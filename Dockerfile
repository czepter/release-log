# The build needs the whole toolchain; the running service needs a directory.
# Nitro bundles web/.output with its own node_modules, the compiled
# better-sqlite3 binary included -- so the runtime stage carries no compiler and
# runs no npm install. The image is therefore built for one architecture: build
# it where you run it, or with buildx --platform.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV CI=1
# better-sqlite3 falls back to compiling from source whenever its install
# script cannot fetch a prebuilt binary, and a build host without a compiler
# then fails with a node-gyp error. Only this stage needs the toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# The postinstall hook is "nuxt prepare web", so the sources have to be in
# place before npm ci runs -- no dependency-only cache layer here.
COPY . .
RUN npm ci && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The bundled server no longer sits next to drizzle/, so it is told where the
# migrations are instead of guessing (web/server/utils/core.ts).
ENV MIGRATIONS_DIR=/app/drizzle
ENV DB_PATH=/data/release-log.sqlite
ENV PORT=3000

COPY --from=build /app/web/.output ./web/.output
COPY --from=build /app/drizzle ./drizzle

# The one piece of state: the SQLite index. Releases and media live in the
# GitHub repositories, not here.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web/.output/server/index.mjs"]
