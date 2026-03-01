FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

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
FROM node:22-alpine

WORKDIR /app

# Production node_modules (better-sqlite3 native addon + @mtcute/wasm)
COPY --from=prod-deps /app/node_modules /app/node_modules

# Bundled application
COPY --from=build /app/dist /app/dist

# Bot data directory (session will be mounted as a volume)
RUN mkdir -p /app/bot-data

CMD [ "node", "--enable-source-maps", "dist/main.mjs" ]
