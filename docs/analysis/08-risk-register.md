# Risk Register

Structured risk list from the LLM analysis of commit `83d9392`. Each entry:
**id / statement / evidence (file:line) / trigger scenario / impact /
likelihood / current mitigation / recommendation.**

Impact and likelihood are qualitative: High / Medium / Low. "Current
mitigation" records what already exists, including cases where the mitigation
is only documentation.

## Build and deployment

### R-01 — Build fails on a clean checkout because `bot-data/quizzes.json` is not committed

- **Evidence**: `bot-data/.gitignore` ignores everything except itself;
  `build.mjs:71` does `cpSync(resolve(root, 'bot-data/quizzes.json'), …)` with
  no existence check. Reproduced: `pnpm build` fails with `ENOENT` after the
  bundle is written.
- **Trigger**: clone → `pnpm build` (also breaks `Dockerfile:14`).
- **Impact**: High — no production artifact can be produced without a manual,
  undocumented step.
- **Likelihood**: High — the file is absent by construction in a clean repo.
- **Current mitigation**: none.
- **Recommendation**: commit an example `quizzes.json`, or make the copy step
  skip a missing file and fail only the runtime loader (which already degrades
  gracefully via `quizSource.ts:48-51`).

### R-02 — Floating `node:22-alpine` tag can resolve below Node 22.13, where `node:sqlite` is unavailable

- **Evidence**: `Dockerfile:1,21`; `sqliteStore.ts:20` imports `node:sqlite`
  (unflagged since Node 22.13). No engine pin in `package.json`.
- **Trigger**: Docker builder has a cached `node:22-alpine` older than 22.13.
- **Impact**: High — container starts and then crashes when the state store
  initializes.
- **Likelihood**: Medium.
- **Current mitigation**: none.
- **Recommendation**: pin `node:22.13-alpine` or newer patch tag; optionally
  add `engines.node >= 22.13`.

### R-03 — Default memory backend plus `restart: always` abandons in-flight sessions on every restart

- **Evidence**: `env.ts:43` defaults `STATE_BACKEND=memory`;
  `docker-compose.yaml:6` restarts always; `main.ts:169-172` recovery lists
  only persisted sessions; `memoryStore.ts:15-23` is process-local.
- **Trigger**: any crash/restart (which is the designed crash policy,
  `main.ts:24-32`).
- **Impact**: High — restricted entrants stay restricted and pending join
  requests stay pending, with no timer and no recovery.
- **Likelihood**: High — this is the default configuration.
- **Current mitigation**: `docs/design.md:21-23` states that persistence
  requires a persistent backend.
- **Recommendation**: default the compose deployment to sqlite, or refuse to
  start (warning) when memory is used with `restart: always`.

### R-04 — `.env.example` omits state-backend variables and tags dev events as production

- **Evidence**: `.env.example` has no `STATE_BACKEND`/`STATE_SQLITE_PATH`/
  `REDIS_URL` (all supported in `env.ts:7-13,43-46`); it sets
  `SENTRY_ENVIRONMENT=production` unconditionally (line 7).
- **Trigger**: operator configures from the example.
- **Impact**: Medium — persistence and Sentry environment are misconfigured
  silently.
- **Likelihood**: Medium.
- **Current mitigation**: none.
- **Recommendation**: add the three variables and document the production tag
  choice.

### R-05 — Duplicate `better-sqlite3` versions installed (direct pin vs mtcute range)

- **Evidence**: `package.json:27` declares `better-sqlite3@^12.6.2`;
  `@mtcute/node` depends on `^12.10.0`. The lockfile resolves them to two
  different versions — `pnpm why` shows `12.11.1` (under `@mtcute/node`) and
  `12.6.2` installed side by side.
- **Trigger**: install/build (both versions' native modules must be
  built/packaged).
- **Impact**: Low — image size/build time, version drift.
- **Likelihood**: High — deterministic.
- **Current mitigation**: `pnpm.onlyBuiltDependencies` approves the scripts.
- **Recommendation**: align the direct dependency with mtcute's range or drop
  the direct entry.

## Session correctness

### R-06 — Permanent mute is applied before the session is saved; a save failure strands the user forever

- **Evidence**: `Flow.res:172-176` calls `restrictUser` before `Session.save`;
  `interaction.ts:238-266` calls `restrictChatMember` **without `until`**, and
  mtcute's default `until = 0` means forever. `dp.onError` only logs
  (`main.ts:45-48`).
- **Trigger**: sqlite/redis save rejects (I/O error, network error) after the
  mute succeeded.
- **Impact**: High — the entrant is permanently muted with no session, no
  observer, and nothing for restart recovery to list.
- **Likelihood**: Low–Medium.
- **Current mitigation**: none.
- **Recommendation**: pass a finite `until` (e.g. deadline + slack), or save
  before restricting, or compensate by unmuting when save fails.

### R-07 — The discarded timeout-observer chain can reject and crash the process

- **Evidence**: `Flow.res:112-122` forks and `discard`s the observer promise;
  `state.ts:41-52` (`getById`) and `state.ts:85-86` (`claim`) can reject;
  `main.ts:29-32` turns unhandledRejection into `exit(1)`. A probe with a
  rejecting `waitAndPeek` confirmed the unhandled rejection.
- **Trigger**: Redis/SQLite error 60s after a challenge.
- **Impact**: High — the safety net itself crashes the bot (crash loop while
  the backend is down).
- **Likelihood**: Low–Medium.
- **Current mitigation**: `Flow.res:112-113` requires (by comment only) the
  discarded chain never to reject.
- **Recommendation**: attach `.catch` to the observer chain (log at error
  level) so it can never become an unhandled rejection.

### R-08 — Restart recovery near session TTL expiry re-arms a full 60s timer and loses the settlement

- **Evidence**: session TTL `5 * 60_000` (`state.ts:18`); observer delay `60s`
  (`Flow.res:5,114-121`); recovery re-arms without knowing the original
  deadline (`main.ts:169-172`).
- **Trigger**: restart happens ≥ 4 minutes after save (e.g. long login/startup
  after a crash).
- **Impact**: High — the session expires before the re-armed observer peeks;
  `waitAndPeek` returns `None`; no decision is enforced (muted user stays
  muted / join request stays pending).
- **Likelihood**: Low–Medium.
- **Current mitigation**: none (design.md:91-94 assumes re-arming is
  sufficient).
- **Recommendation**: persist an absolute deadline and re-arm with the
  remaining time; for already-expired sessions, enforce timeout immediately at
  boot.

### R-09 — Concurrent starts for the same entrant create two live sessions (double challenge, double settlement)

- **Evidence**: TOCTOU between `findPending` (`Flow.res:138`) and `save`
  (`Flow.res:176`); no per-entrant lock or unique constraint in any backend
  (`store.ts:23-29`). Probe confirmed `findByToken(old)` still resolves and
  claims the old session after a newer save.
- **Trigger**: two near-simultaneous join/member updates for the same
  `(chat, user)`.
- **Impact**: High — two challenges, two observers, possible double kick/
  decline; on memory/redis, claiming the old session also deletes the new
  session's pending mapping (`memoryStore.ts:65`, `redisStore.ts:36-39`).
- **Likelihood**: Low.
- **Current mitigation**: sequential Flow path cleans an old pending session
  when it sees one (`Flow.res:141-145`); claim arbitration only protects per
  session, not per entrant.
- **Recommendation**: add an atomic "claim the pending slot before save"
  primitive to `StateStore` (save-if-absent with old-session cleanup).

### R-10 — Enforcement failure is invisible to the flow; audit logs success/failure that did not happen

- **Evidence**: `interaction.ts:168-170` catches and logs
  `enforceDecision` errors; Flow then logs `Success`/`Fail_*`
  (`Flow.res:244,262,107`).
- **Trigger**: Telegram API error on unrestrict/approve/kick/decline.
- **Impact**: High for the affected user — verified user stays restricted or
  failing user stays; audit record disagrees with reality.
- **Likelihood**: Low–Medium.
- **Current mitigation**: Sentry/console records the underlying error.
- **Recommendation**: return a result from `enforceDecision`, add a distinct
  audit tag for enforcement failure, and define a retry/compensation policy.

### R-11 — Wrong-answer path is fail-open if cooldown write fails after claim

- **Evidence**: `Flow.res:247-262`: claim → acknowledge → `Cooldown.apply` →
  punishment. If `Cooldown.apply` rejects, the chain stops after the session is
  deleted.
- **Trigger**: state backend error at the exact wrong-answer moment.
- **Impact**: Medium — a wrong answer is not punished and no observer remains.
- **Likelihood**: Low.
- **Current mitigation**: none.
- **Recommendation**: reorder (punish first, cooldown after) or catch cooldown
  errors so punishment always runs.

### R-12 — Timeout/send-failure does not apply cooldown; join requests can be retried endlessly

- **Evidence**: wrong answer applies `Cooldown.apply(60)`
  (`Flow.res:251-255`); timeout (`Flow.res:86-110`) and send failure
  (`Flow.res:66-81`) do not. Join-request decline is a one-shot decline
  (`interaction.ts:159-165`).
- **Trigger**: a user repeatedly requests to join and lets each deadline pass.
- **Impact**: Low–Medium — unbounded retry/notification noise.
- **Likelihood**: Medium.
- **Current mitigation**: none; policy is undocumented in design.md.
- **Recommendation**: decide the cooldown policy explicitly and apply it to
  all failure settlements (or document why not).

### R-13 — Invalid quiz data can brick verification for every entrant

- **Evidence**: `quizSource.ts:25-32` maps JSON without validating
  `CorrectOptionIndex`/`Options`; `Flow.res:26-27` uses `Array.getUnsafe`.
  `/reload` reports success for invalid data (`quizSource.ts:60-69`).
- **Trigger**: malformed `bot-data/quizzes.json` (manual edit or bad reload).
- **Impact**: Medium — every `startVerification` throws before any decision;
  join requests sit pending, in-group entrants get no challenge.
- **Likelihood**: Low–Medium.
- **Current mitigation**: startup parse errors are caught (`quizSource.ts:48-51`);
  runtime errors surface only as dispatcher error logs.
- **Recommendation**: validate on load/reload; make `prepareQuiz` total
  (return `option` or filter invalid quizzes).

## State backends

### R-14 — Redis `save` is a non-atomic pipeline and partial failures leave orphaned state

- **Evidence**: `redisStore.ts:80-96` uses `pipeline()` and ignores
  `exec()` results; claim returns early when `sess` is missing
  (`redisStore.ts:33-34`) and skips index cleanup when `rel` is missing
  (`redisStore.ts:35-42`).
- **Trigger**: one command of the save pipeline fails (OOM, WRONGTYPE,
  Cluster CROSSSLOT, disconnect mid-pipeline).
- **Impact**: Medium — session/pending/token state inconsistent until TTL;
  claim can leave orphan indexes.
- **Likelihood**: Low.
- **Current mitigation**: 5-minute TTL eventually cleans everything.
- **Recommendation**: make save atomic (Lua/MULTI) or inspect `exec()` results
  and compensate.

### R-15 — Redis claim may be auto-resent after connection loss; the real winner receives `undefined`

- **Evidence**: `redisStore.ts:51` (`maxRetriesPerRequest: 3`); ioredis
  default `autoResendUnfulfilledCommands: true`. If the Lua script executed
  but the reply was lost, the resent script sees no session and returns
  `false` (`redisStore.ts:32-44,110-112`).
- **Trigger**: network blip exactly on a claim.
- **Impact**: Medium — the winner gets "expired", no decision is enforced, the
  entrant remains restricted.
- **Likelihood**: Low.
- **Current mitigation**: none.
- **Recommendation**: use `autoResendUnfulfilledCommands: false` (and explicit
  error handling) for claim, or make claim idempotent with a tombstone.

### R-16 — SQLite has no busy timeout; concurrent writers throw instead of waiting

- **Evidence**: `sqliteStore.ts:50` constructs `DatabaseSync` with no options;
  Node's default `timeout` is `0`. A two-connection probe produced an
  immediate `database is locked`.
- **Trigger**: multiple processes/connections writing the same state file.
- **Impact**: Medium — claim/save rejects and propagates (or, on the observer
  path, contributes to R-07).
- **Likelihood**: Low in the single-container deployment; Medium if the
  service is ever scaled.
- **Current mitigation**: single-process deployment.
- **Recommendation**: pass a busy timeout to `DatabaseSync`.

### R-17 — Redis deployment is single-instance-only; Cluster is not supported

- **Evidence**: `redisStore.ts:19-21` acknowledges it; keys lack a hash-tag
  (`redisStore.ts:59-63`); the Lua script accesses undeclared dynamic keys
  (`redisStore.ts:32-44`); client is `new Redis` (`redisStore.ts:50-51`).
- **Trigger**: pointing `REDIS_URL` at a Cluster/proxy that enforces slots.
- **Impact**: Medium — claim fails (`CROSSSLOT`), settlements stop.
- **Likelihood**: Low (documented constraint).
- **Current mitigation**: documentation in code.
- **Recommendation**: reject cluster endpoints at startup or implement
  hash-tagged keys and explicit `KEYS`.

## Observability, audit, and PII

### R-18 — Sentry `beforeSend` does not scrub `extra.logger_message`

- **Evidence**: `sentry.ts:43-52` scrubs `message` and `exception.value` only;
  `sentry.ts:95-99` attaches context as `extra.logger_message` for Error
  values.
- **Trigger**: a future `logger.error` with a raw numeric ID in its context
  string (currently all warn/error sites avoid this: `joinPolicy.ts:16-17`).
- **Impact**: Medium — raw Telegram IDs leak to Sentry, violating the stated
  policy (`design.md:124-131`).
- **Likelihood**: Low today; the guard is convention, not mechanism.
- **Current mitigation**: call-site discipline only.
- **Recommendation**: scrub extras in `sanitizeEvent`, or don't attach context
  as extra.

### R-19 — Audit log can record success/failure that was not enforced, and can order `REQUEST_START` after the terminal event

- **Evidence**: see R-10; late `Request_start` path `Flow.res:192-194`
  (updateLocation no-op but log still happens) with races documented in
  [02-behavior-and-invariants.md](02-behavior-and-invariants.md) INV-10.
- **Trigger**: fast correct click; challenge send longer than 60s; enforcement
  API error.
- **Impact**: Medium — audit trail becomes unreliable for incident review.
- **Likelihood**: Low–Medium.
- **Current mitigation**: none.
- **Recommendation**: make `updateLocation` return liveness, gate
  `Request_start` on it, and tag enforcement failures explicitly.

### R-20 — LOG_PEER failures lose the only audit record

- **Evidence**: `interaction.ts:197-199` logs and swallows; no retry or
  fallback store.
- **Trigger**: Telegram error sending the audit message.
- **Impact**: Low–Medium — gap in the audit trail; console/Sentry still has a
  local record.
- **Likelihood**: Low.
- **Current mitigation**: Sentry error event records the failure.
- **Recommendation**: accept for now, or queue-and-retry audit messages.

## Top risks by exposure

1. **R-06** permanent mute with no safety net (high impact, plausible trigger).
2. **R-03** default memory backend losing every in-flight session on restart.
3. **R-01** clean checkout cannot build.
4. **R-07** observer chain rejection crashing the process.
5. **R-10** enforcement failures recorded as success/failure.
6. **R-08** restart near TTL expiry leaving entrants stuck.
