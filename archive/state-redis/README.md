# Archived: Redis StateStore

The Redis state backend is **not part of the main package** in the current
default build/install/image. It is archived here to preserve the implementation
and its tests while the project decides how/when to reintroduce an optional
Redis backend.

## What changed

- Removed from `src/interpreter/state/`
- Removed `ioredis` from `dependencies` and `ioredis-mock` from
  `devDependencies`
- Removed `STATE_BACKEND=redis` / `REDIS_URL` from the main app's env contract
- Removed the Redis conformance test from the root `pnpm test` script

## Files

- `redisStore.ts` — the Redis `StateStore` implementation (ioredis)
- `redisStore.test.ts` — conformance test using `ioredis-mock` or live Redis
- `ioredis-mock.d.ts` — type declaration for `ioredis-mock`

These files are preserved as of the removal commit. Their relative imports
still point at the old `src/` layout, so they are **reference material**, not a
runnable package; a reintroduction should re-home them and rewire imports.

## Reintroducing Redis

Tracked in the GitHub issue created alongside this archive. Any reintroduction
should decide:

- How the backend is loaded without being bundled by default (e.g. dynamic
  import / separate workspace package)
- Where `StateStore` contract types live so they do not drift
- How root tests stay memory+sqlite only while Redis gets its own verification
- Whether existing Redis hardening issues from the old code remain applicable