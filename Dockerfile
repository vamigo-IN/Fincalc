# syntax=docker/dockerfile:1.7
#
# bookworm-slim, NOT alpine. Prisma ships prebuilt query-engine binaries per libc;
# on musl the wrong binary fails at CONTAINER START with "Query engine binary for
# current platform could not be found" — after a green build. ~40MB more image is
# cheaper than that class of bug (docs/fincalc-2.0/08 §4).

# ---------- deps ----------
FROM node:22.14-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# ---------- build ----------
FROM node:22.14-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
 && npm run build \
 && npm prune --omit=dev \
 && npx prisma generate
# `prisma generate` runs TWICE on purpose: `npm prune` deletes the generated
# client along with the dev dependencies. Regenerating after the prune is what
# makes the runtime image work.

# ---------- runtime ----------
FROM node:22.14-bookworm-slim AS runtime
# PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: the CLI verifies a CACHED engine by
# fetching its .sha256 from binaries.prisma.sh — which fails on the internal
# network even though the binary is present. This skips that network round trip.
ENV NODE_ENV=production TZ=UTC CHECKPOINT_DISABLE=1 PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --from=build --chown=node:node /app/prisma       ./prisma
COPY --from=build --chown=node:node /app/package.json ./
USER node

# Warm the Prisma schema-engine cache AT BUILD TIME.
#
# fincalc_migrate runs `prisma migrate deploy` from this image on the INTERNAL
# network, which has no internet. The Prisma 6 CLI fetches the schema engine on
# demand from binaries.prisma.sh and fails there with EAI_AGAIN. The engine
# bundled in node_modules is the openssl-1.1.x build, but bookworm needs 3.0.x,
# so pointing PRISMA_SCHEMA_ENGINE_BINARY at it does not help either.
#
# `migrate diff` needs the schema engine but NOT a database, so it downloads and
# caches the right binary under /home/node/.cache/prisma. The build stage has
# network; the runtime container then never needs any. Run as `node` so the cache
# lands in the home directory the container actually uses.
RUN npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /dev/null \
 && test -x "$(find /home/node/.cache/prisma -name schema-engine -type f | head -1)" \
 && echo "schema-engine cached at build time"

EXPOSE 8087
# dumb-init as PID 1: Node neither reaps zombies nor forwards signals, so without
# it `docker stop` waits the full grace period and then SIGKILLs mid-request.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/server.js"]
