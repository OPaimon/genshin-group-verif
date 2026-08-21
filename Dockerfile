FROM node:22.13-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Node 22.13 ships an older Corepack keyring that cannot verify current pnpm
# releases. Upgrade Corepack, then activate the packageManager version once in
# the shared base stage so parallel install stages do not race on discovery.
RUN npm install --global corepack@0.31.0 \
    && corepack enable \
    && corepack prepare pnpm@10.17.1 --activate

COPY . /app
WORKDIR /app

# ── Stage 1: install ALL deps + build the bundle ──────────────
FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

# ── Stage 2: install only production deps ─────────────────────
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ── Stage 3: minimal production image ─────────────────────────
FROM node:22.13-alpine

WORKDIR /app

# Production node_modules (better-sqlite3 native addon for @mtcute/node session
# storage + @mtcute/wasm; state sqlite uses Node built-in node:sqlite)
COPY --from=prod-deps /app/node_modules /app/node_modules

# Bundled application
COPY --from=build /app/dist /app/dist

# Bot data directory (session will be mounted as a volume)
RUN mkdir -p /app/bot-data

CMD [ "node", "--enable-source-maps", "dist/main.mjs" ]
