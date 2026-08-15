# Deployment, Build, and Configuration

This is the P2 deployment reference: runtime requirements, environment
configuration, the build pipeline, Docker behavior, and the verified
deployment-blocking gap.

All line references are to commit `83d9392`.

## Runtime requirements

- Runtime: Node 22 Alpine per `Dockerfile:1,21`; the production bundle targets
  `node22` (`build.mjs:39`).
- The sqlite backend uses built-in `node:sqlite` (`sqliteStore.ts:20`), which
  is unflagged since **Node 22.13**. `Dockerfile` uses the floating tag
  `node:22-alpine` (`Dockerfile:1,21`), so an old cached image (< 22.13) would
  start the bundled bot and then crash on `node:sqlite` import at state-store
  creation time. Pin a concrete patch tag.
- `@mtcute/wasm` ships WASM; the build emits `.wasm` as files
  (`build.mjs:55-56`).
- `better-sqlite3` is required **by mtcute**, not by the bot's state backend:
  `@mtcute/node` depends on `better-sqlite3@^12.10.0` (its sqlite session
  driver), and this repo also declares a direct `better-sqlite3@^12.6.2`
  (`package.json:27`). `pnpm why` shows both `12.11.1` (under `@mtcute/node`)
  and `12.6.2` installed — two native addons instead of one. Align the direct
  entry with mtcute's range or drop it (keeping the
  `onlyBuiltDependencies` entry, `package.json:42-45`).
- `@mtcute/html-parser` and `@mtcute/wasm` are also transitive dependencies of
  `@mtcute/node` and are re-declared directly at the same versions
  (`package.json:22,24`); harmless but redundant.

## Environment matrix

Source: `env.ts:1-47`. Validation is hand-rolled (no Zod), despite
`.github/copilot-instructions.md:15-16` claiming Zod — `docs/design.md:189` is
explicit that the code is authoritative.

| Variable | Required | Default | Validation | Notes |
| --- | --- | --- | --- | --- |
| `API_ID` | yes | — | non-empty and `Number()` finite (`env.ts:3-5`) | |
| `API_HASH` | yes | — | non-empty | |
| `BOT_TOKEN` | yes | — | non-empty | |
| `LOG_PEER` | yes | — | non-empty and numeric | peer receiving audit messages |
| `SENTRY_DSN` | no | `''` | none | empty/absent disables Sentry (`sentry.ts:60`) |
| `SENTRY_ENVIRONMENT` | no | `production` if `NODE_ENV === 'production'`, else `development` | none | esbuild defines `NODE_ENV=production` (`build.mjs:54`) |
| `ADMIN_IDS` | no | `[]` | comma-separated finite numbers (`env.ts:15-23`) | empty disables `/reload` |
| `AD_LIST_URL` | no | `https://t.me/addlist/UEpWJGzDD6A1Y2I1` | none | empty string disables the ad block (`env.ts:40`) |
| `STATE_BACKEND` | no | `memory` | must be `memory`/`sqlite`/`redis` (`env.ts:7-10`) | |
| `STATE_SQLITE_PATH` | no | `bot-data/state.db` | none | |
| `REDIS_URL` | no | `''` | required non-empty when `STATE_BACKEND=redis` (`env.ts:11-13`) | |

`.env.example` documents only `API_ID`, `API_HASH`, `BOT_TOKEN`,
`SENTRY_DSN`, `SENTRY_ENVIRONMENT=production`, `LOG_PEER`, `ADMIN_IDS`, and an
`AD_LIST_URL` comment. It is missing `STATE_BACKEND`, `STATE_SQLITE_PATH`, and
`REDIS_URL` even though all three are supported and two of them are deployment
critical. It also pins `SENTRY_ENVIRONMENT=production`, so copying the example
into local dev tags dev events as production.

Verified startup validation behavior:

- no env → `Invalid env: API_ID, API_HASH, BOT_TOKEN, and LOG_PEER are required.`
- `STATE_BACKEND=weird` → `Invalid env: STATE_BACKEND must be one of "memory", "sqlite", "redis".`

## Scripts and build pipeline

`package.json` scripts:

| Script | What it runs |
| --- | --- |
| `dev` | `dotenv tsx watch ./src/main.ts` |
| `start` | `tsx --env-file=.env ./src/main.ts` |
| `build` | `node build.mjs` |
| `start:prod` | `node --enable-source-maps dist/main.mjs` |
| `test` | ReScript compile, then two `node --test` batches (Flow + TS suites) |

`build.mjs` pipeline:

1. `pnpm res:build` compiles ReScript in-source to `src/*.res.mjs` and emits
   `Domain.gen.tsx` (`build.mjs:28-29`, `rescript.json`).
2. esbuild bundles `src/main.ts` → `dist/main.mjs`, ESM, node22, minified,
   sourcemap with `sourcesContent: false`; `better-sqlite3` external; `.wasm`
   emitted as files; `process.env.NODE_ENV` defined as `"production"`
   (`build.mjs:34-65`).
3. Copies `bot-data/quizzes.json` into `dist/bot-data/` (`build.mjs:68-71`).
4. Writes `dist/metafile.json` (`build.mjs:74`).

## Verified build failure

**`pnpm build` fails on a clean checkout.**

```
Error: ENOENT: no such file or directory, lstat '…/bot-data/quizzes.json'
    at cpSyncFn (node:internal/fs/cp/cp-sync:56:13)
    …
    at file:///…/build.mjs:71:1
```

Facts:

- `bot-data/` contains only `.gitignore`; `quizzes.json` is git-ignored
  (`bot-data/.gitignore` content: `*` and `!.gitignore`).
- The failure happens at `build.mjs:71`, **after** the bundle is written
  (`dist/main.mjs` and `dist/main.mjs.map` were produced; `metafile.json` and
  the quiz copy were not).
- The Docker build copies the same source tree (`.dockerignore` does not
  exclude `bot-data/`), so `RUN pnpm build` (`Dockerfile:14`) fails identically.
- The runtime reads `process.cwd()/bot-data/quizzes.json`
  (`quizSource.ts:21`) — in Docker that is the mounted
  `/app/bot-data/quizzes.json` (`docker-compose.yaml:9-10`), so the
  `dist/bot-data` copy built into the image is not even the file the container
  reads. The build-time copy is both fragile and redundant.

An operator must create `bot-data/quizzes.json` before build **and** provide it
at runtime; the repository should ship a sample file or the pipeline should
tolerate its absence.

## Dockerfile and docker-compose behavior

`Dockerfile` stages:

1. `base`: `node:22-alpine`, corepack/pnpm (`Dockerfile:1-9`).
2. `build`: install all deps with cache mount, `pnpm build` (`Dockerfile:11-14`).
3. `prod-deps`: `pnpm install --prod --frozen-lockfile` (`Dockerfile:16-18`).
4. Final: copy prod `node_modules` and `dist`, `mkdir -p /app/bot-data`, run
   `node --enable-source-maps dist/main.mjs` (`Dockerfile:20-34`).

`docker-compose.yaml`: one `bot` service; `build` from repo root;
`restart: always`; `.env` via `env_file`; bind mount `./bot-data` over
`/app/bot-data` (`docker-compose.yaml:3-10`).

Deployment behavior notes:

- `restart: always` plus the crash policy (`main.ts:24-32`) means any
  uncaught error or unhandled rejection restarts the process.
- With the default `STATE_BACKEND=memory`, a restart loses every in-flight
  session and nothing is re-armed (`main.ts:169-172`, `env.ts:43`). Already
  restricted entrants stay restricted, and pending join requests stay pending.
- The mtcute session is stored at `bot-data/session` (`main.ts:37`) inside the
  mounted volume, so login state survives restarts.
- The sqlite state file default `bot-data/state.db` (`env.ts:44`) also lands in
  the mounted volume; redis needs `REDIS_URL`.
- Logs go to stdout/stderr (Docker default driver); there is no application
  log shipping (`design.md:156-157`).

## Configuration drift

- `.github/copilot-instructions.md:15-16` claims Zod env validation; there is
  no zod dependency and `env.ts` validates by hand. `docs/design.md:187-190`
  declares itself authoritative.
- `.env.example` lacks the three `STATE_*`/`REDIS_URL` variables (see matrix).
- `docs/design.md:152` says "Node 22 Alpine"; the floating `node:22-alpine`
  tag makes the actual patch version time-dependent (and may be below 22.13 on
  cached builders).

## Recommendations summary

1. Commit an example `quizzes.json` (or make `build.mjs` copy
   optional/skip-when-missing) and document the runtime file requirement.
2. Add `STATE_BACKEND`, `STATE_SQLITE_PATH`, `REDIS_URL` to `.env.example`.
3. Pin the Node image to a tag ≥ 22.13.
4. Align or remove the direct `better-sqlite3` dependency with mtcute's range.
5. Either default `STATE_BACKEND` to `sqlite` for the compose deployment or add
   a startup warning when memory is selected with `restart: always`.
