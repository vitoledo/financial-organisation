# syntax=docker/dockerfile:1

# =============================================================================
# Build stage — compile TypeScript to dist/
# =============================================================================
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# =============================================================================
# Runtime stage — prod deps + supercronic, no compiler
# =============================================================================
FROM node:22-bookworm-slim AS runtime
ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.33
ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    HEADLESS=1 \
    LOG_TO_FILE=0
WORKDIR /app

# tzdata so America/Sao_Paulo resolves; ca-certificates for HTTPS to the APIs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# supercronic: a single static binary that runs the crontab as PID 1 and logs
# each job (and its exit code) to stdout. The binary is verified against the
# .sha1 checksum published alongside it in the same pinned release, so a
# corrupted or tampered download fails the build instead of shipping.
ADD https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH} /usr/local/bin/supercronic
ADD https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}.sha1 /tmp/supercronic.sha1
RUN echo "$(awk '{print $1}' /tmp/supercronic.sha1)  /usr/local/bin/supercronic" | sha1sum -c - \
 && chmod +x /usr/local/bin/supercronic \
 && rm /tmp/supercronic.sha1

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# Prod deps only — pulls the glibc prebuilt better-sqlite3 for this arch, so no
# build toolchain is needed in the final image.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY docker/crontab ./crontab
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs

# WAL writes -wal/-shm siblings, so the process needs write on the data
# directory (not just the db file) → own /app as the non-root node user.
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R node:node /app

USER node
VOLUME ["/app/data"]

# Cron work is idle between runs, so the healthcheck reads the heartbeat and
# goes unhealthy if the last run failed or is stale. start-period covers the
# window before the first scheduled run on a fresh container.
HEALTHCHECK --interval=6h --timeout=10s --start-period=24h \
  CMD node /app/docker/healthcheck.mjs || exit 1

ENTRYPOINT ["entrypoint.sh"]
