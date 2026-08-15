# Testing Status

This is the P2 reference for the test suite: what exists, what it pins, and
where the weak spots are. All results are from commit `83d9392`.

## Inventory and how to run

`pnpm test` (`package.json`) runs two `node --test` batches after compiling
ReScript:

1. `node --test src/FlowTest.res.mjs` — the ReScript state-machine suite.
2. `node --import tsx --test … messages.test.ts ttlMap.test.ts
   memoryStore.test.ts sqliteStore.test.ts redisStore.test.ts` — the TS suites.

Measured result: **61/61 pass** (17 Flow tests + 44 TS tests). `pnpm lint`
passes; `pnpm exec tsc --noEmit` passes. `pnpm build` fails (see
[06-deployment.md](06-deployment.md)).

| Suite | File | Tests | What it pins |
| --- | --- | --- | --- |
| Flow state machine | `src/FlowTest.res` | 17 | Branch coverage of `startVerification`, `handleCallback`, `handleTimeout`, and the claim-race matrix via trace + in-memory state assertions |
| Store conformance ×3 | `src/interpreter/state/{memory,sqlite,redis}Store.test.ts` + `storeContract.ts` | 11 × 3 = 33 | Identical contract for every backend: save/indexes, findPending, claim single-winner, no-resurrect updateLocation, TTL expiry, newest-wins, listAll, cooldown TTL |
| Message copy | `src/interpreter/messages.test.ts` | 6 | `formatDuration`, `formatLogKind`, challenge text/ad block, audit message tags |
| TTLMap | `src/interpreter/ttlMap.test.ts` | 5 | lazy expiry, has, delete, overwrite refresh, background sweep (mocked timers) |

## FlowTest coverage and trace assertions

`FlowTest.res` drives `Flow.Make` with `MockInterpreter` (identity monad) and
asserts both the **effect order** (trace prefixes) and the **state invariants**
(session/token/lookup/cooldown counts). Covered scenarios:

- `startVerification`: in-group and join-request happy paths; cooldown bail;
  existing-pending cleanup + bail; empty quiz bank bail without restriction;
  challenge-send failure in both contexts (`FlowTest.res:76-267`).
- `handleCallback`: correct, wrong (+cooldown), foreign user (no claim),
  invalid token (`FlowTest.res:281-387`).
- `handleTimeout`: with and without `verificationLocation`
  (`FlowTest.res:393-445`).
- Claim races: second claim loses; late timeout after answer; click after
  timeout; duplicate correct clicks (`FlowTest.res:451-530`).

The happy-path trace assertions also pin that the observer is armed **before**
`presentChallenge` (`FlowTest.res:82-96`) and that join requests never call
`restrictUser` (`FlowTest.res:115`).

## Store conformance suite design

`storeContract.ts:55-184` defines 11 tests and each backend test file hands it
a factory. The suite deliberately uses real short timers for TTL tests
(`storeContract.ts:6-8`), because sqlite/redis expire against the wall clock.

It pins, for all three backends identically:

- save → every option token resolves; lookup resolves (`storeContract.ts:67-81`)
- claim returns once and removes everything; 5 parallel claims → exactly one
  winner (`storeContract.ts:90-114`)
- `updateLocation` works and does **not resurrect** a claimed session
  (`storeContract.ts:116-140`)
- session TTL expiry covers id/token/lookup/claim (`storeContract.ts:142-151`)
- newest save wins pending lookup (`storeContract.ts:153-160`)
- `listAll` reflects live sessions (`storeContract.ts:162-172`)
- cooldown TTL (`storeContract.ts:174-183`)

Redis runs against `ioredis-mock` unless `REDIS_URL` is set
(`redisStore.test.ts:17-23`). No Redis server was available in this
environment, so the live-Redis branch was **not run**; the mock executes the
same Lua claim script via fengari, which validates the script logic but not a
real server's failure modes (see [04-state-backends.md](04-state-backends.md)).

## Coverage map

| Source file | Direct tests | Notes |
| --- | --- | --- |
| `src/Flow.res` | `FlowTest.res` (17) | deep branch coverage; async/rejection semantics untested |
| `src/MockInterpreter.res` | used by all Flow tests | test double, not itself tested |
| `src/interpreter/state/memoryStore.ts` | contract (11) | plus two read-only probes used for this analysis |
| `src/interpreter/state/sqliteStore.ts` | contract (11) | |
| `src/interpreter/state/redisStore.ts` | contract (11, mock) | live Redis not run |
| `src/interpreter/messages.ts` | `messages.test.ts` (6) | |
| `src/interpreter/ttlMap.ts` | `ttlMap.test.ts` (5) | |
| `src/interpreter/state/store.ts`, `factory.ts`, `peer.ts`, `task.ts` | indirectly via contract | no direct tests |
| `src/interpreter/state.ts` facade | indirectly via backends | waitAndPeek/cooldown conversion untested |
| `src/interpreter/quizSource.ts` | none | file loading/reload untested |
| `src/interpreter/interaction.ts` | none | all mtcute calls untested |
| `src/interpreter/runtime.ts` | none | |
| `src/main.ts` | none | wiring/recovery untested |
| `src/env.ts` | none | validation paths untested |
| `src/logger.ts` | none | splitError/Sentry fan-out untested |
| `src/sentry.ts` | none | sanitizer not exported/untested |
| `src/joinPolicy.ts` | none | fail-closed branch untested |
| `build.mjs` / Docker / compose | none | build itself fails on clean checkout |

## Gaps

### Untested modules

The entire production adapter surface (`interaction.ts`, `quizSource.ts`,
`joinPolicy.ts`, `main.ts`, `env.ts`, `logger.ts`, `sentry.ts`) has zero direct
tests. These are exactly the modules containing error policies, PII scrubbing,
admin gating, and restart recovery — several of which are risk-listed in
[08-risk-register.md](08-risk-register.md).

### Mock vs production semantics

`MockInterpreter` is an identity monad (`t<'a> = 'a`), so Flow tests are
synchronous and cannot observe await-point interleavings or rejections. Three
specific fidelity gaps:

- `waitAndPeek` always returns `None` (`MockInterpreter.res:259-262`) — the
  full observer chain (`armTimeoutObserver → waitAndPeek(Some) →
  handleTimeout`) has never run in a test.
- `updateLocation` writes unconditionally (`MockInterpreter.res:253-257`) and
  would resurrect a claimed session; the real backends' no-resurrect behavior
  is only pinned by the store contract, not at Flow level.
- `restrictUser`/Telegram calls never fail, so error-swallowing paths are
  untested at Flow level.

### Missing scenarios

1. Concurrent `startVerification` for the same entrant (double-session race,
   INV-5 in [02-behavior-and-invariants.md](02-behavior-and-invariants.md)).
2. Rejection of the discarded observer chain (verified as a real unhandled
   rejection by this analysis' probe).
3. `Cooldown.apply` failure on the wrong-answer path (fail-open).
4. claim vs `updateLocation` race (late `Request_start`, late un-cleaned
   challenge message).
5. Restart recovery re-arm, including sessions near TTL expiry.
6. Quiz bank with invalid `correctOptionIndex` / empty options.
7. Real Telegram integration (smoke test against mtcute would need credentials).
8. Live Redis contract (only optional via `REDIS_URL`).

### CI

`.github/` contains only Copilot instructions and ReScript documentation
files; there is **no CI workflow** (`find .github -type f` shows no
`workflows/`). Tests, lint, and typecheck run only manually.

## Prioritized testing opportunities

1. Add a rejecting-mock test: assert the discarded observer chain never
   produces an unhandled rejection (drives the fix in
   [09-deepening-opportunities.md](09-deepening-opportunities.md)).
2. Add store contract tests for the uncovered semantics: old-session claim
   after pending overwrite; `updateLocation` TTL advancement; close-then-use.
3. Make `quizSource.ts` injectable (path + loader) and test load/reload/empty/
   invalid data.
4. Extract the `main.ts` update→input mappings into pure functions and test
   them; they are currently first executed in production.
5. Add binding-contract tests for `AppBridge.res` externals: every name the
   ReScript bridge imports must exist in the TS modules.
6. Run the Redis contract against a real Redis in CI (short TTLs, unique key
   prefixes are already designed for it).
