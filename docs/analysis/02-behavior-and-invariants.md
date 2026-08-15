# Behavior and Invariants

This document is the P0 behavior reference for the verification state machine
in `src/Flow.res`. Domain terms follow [CONTEXT.md](../../CONTEXT.md); the
claim-first settlement decision is [ADR-0001](../adr/0001-claim-first-settlement.md).

All line references are to commit `83d9392`.

## Domain lifecycle summary

1. An entrant triggers one of two **entry** paths: an in-group join
   (`context = In_group`) or a join request (`context = Join_request`).
2. Unless on cooldown or already holding a pending session, a quiz is drawn and
   a **challenge** is presented with one answer token per option.
3. The entrant's click and the **deadline** observer race to **claim** the
   session; exactly one wins and settles it.
4. Settlement is **pass** (lift restriction / approve request) or
   **soft punishment** (kick / decline request). A wrong answer also applies a
   cooldown.

Constants: message deletion delay `10`s (`Flow.res:4`), session deadline
`60`s (`Flow.res:5`), cooldown `60`s (`Flow.res:6`). The persisted session TTL
is `5` minutes (`state.ts:18`).

## Entry points and event wiring

`main.ts` registers four verification-related handlers:

| Update | Handler | Input built | Verification context |
| --- | --- | --- | --- |
| Bot chat join request | `main.ts:86-101` | `userChatId = user` (DM challenge) | `Join_request` |
| Member update `joined`/`added`, non-bot, group/supergroup | `main.ts:105-138` | `userChatId = chat` (in-group challenge) | `In_group` |
| Callback query with data | `main.ts:142-156` | `callbackData = token`, `messageLocation = (q.chat.id, q.messageId)` | — |
| `/ping`, `/reload` | `main.ts:58-82` | — | — |

The in-group path first consults `wasAddedByAdmin`
(`main.ts:119-124`, `joinPolicy.ts:10-19`): creator/admin-added entrants skip
verification; a failed actor lookup returns `false`, so lookup errors can never
become a bypass.

Handler errors are caught by `dp.onError`, logged, and marked handled
(`main.ts:45-48`).

## The state machine

`Flow.Make` (`Flow.res:8-12`) is parameterized by `InteractionSig.S`,
`StateSig.S`, and `QuizSourceSig.S`; production instantiates it in
`AppBridge.res:134`, tests in `MockInterpreter.res:293`.

### `startVerification` (`Flow.res:126-204`)

| # | Effect | Branch outcome |
| --- | --- | --- |
| 1 | `Cooldown.check` (`Flow.res:134`) | `true` → `bail`: temp message + `Punish_soft` (`Flow.res:135-137`, `bail` at `129-132`). No session. |
| 2 | `Session.findPending` (`Flow.res:138`) | `Some(old)` → `cleanupWithMessage` (claim old, schedule cleanup of its challenge message) then `bail` (`Flow.res:141-145`, `42-49`). No new session. |
| 3 | `Quiz.getRandom` (`Flow.res:151`) | `None` → `bail("验证服务当前不可用…")`. Quiz availability is checked **before** any restriction (`Flow.res:149-155`). |
| 4 | `prepareQuiz` (`Flow.res:158`, `24-30`) | Adds a UUID token per option, records `correctToken = options[correctOptionIndex].token`, Fisher–Yates shuffle. `Array.getUnsafe` at `Flow.res:27` assumes a valid index (see INV-9). |
| 5 | Restrict | `In_group` → `restrictUser` (`Flow.res:172-173`); `Join_request` → no-op (`Flow.res:174`). The restriction is applied **before** `Session.save`. |
| 6 | `Session.save` (`Flow.res:176`) | Writes session + all token indexes + pending lookup. |
| 7 | `armTimeoutObserver` (`Flow.res:180`) | Forked, detached chain (below). |
| 8 | `presentChallenge` to `targetChat` (`Flow.res:181-188`, `32-36`) | `Some(loc)` → `updateLocation` then `logActivity(Request_start)` (`Flow.res:192-194`). `None` → `rejectChallengeSendFailure`: claim, and only on `Some` punish + `logActivity(Fail_error)` (`Flow.res:195`, `66-81`). |

`targetChat` (`Flow.res:32-36`): in-group challenge goes to the group chat;
join-request challenge goes to the user DM (`Peer.widen(session.userId)`).

### `armTimeoutObserver` — fork/discard semantics (`Flow.res:112-122`)

```res
S.Session.waitAndPeek(~sessionId=session.id, ~delaySec=60)
->bind(maybeSession =>
  switch maybeSession {
  | Some(session) => handleTimeout(session)
  | None => return()
  })
->discard
```

- The observer is armed **after** `save` and **before** `presentChallenge`
  (`Flow.res:176-188`), so a failed challenge send cannot strand a restricted
  user without a timer.
- `discard` (`Utils.res:16`) drops the resulting Promise without attaching a
  rejection handler. The comment at `Flow.res:112-113` states the requirement:
  this discarded chain must never reject. The real adapters can reject (see
  INV-7 and `05-errors-logging-observability.md`).
- The peek is an optimization, not an arbiter: `waitAndPeek` returns the
  session if still live; `handleTimeout` still claims, and only the claim
  winner acts (`Flow.res:114-121`).

### `handleCallback` (`Flow.res:208-272`)

| # | Effect | Branch outcome |
| --- | --- | --- |
| 1 | `Session.findByToken(callbackData)` (`Flow.res:211`) | `None` → `ackExpired` (`Flow.res:213-215`, `39-40`). No claim, no decision. |
| 2 | User check | `session.userId != userId` → acknowledge "not yours" and leave the session untouched (`Flow.res:217-219`). |
| 3 | `Session.claim` (`Flow.res:224`) | `None` → `ackExpired` (already settled) (`Flow.res:226`). |
| 4a | `Some` and `correctToken == callbackData` | acknowledge pass → `updateStatus` → `enforceDecision(Grant_access)` → `scheduleMessageCleanup(10)` → `logActivity(Success)` (`Flow.res:228-245`). |
| 4b | `Some`, wrong token | acknowledge wrong → `Cooldown.apply(60)` → `rejectAndLog` (updateStatus, `Punish_soft`, `Fail_error`) → `scheduleMessageCleanup(10)` (`Flow.res:247-267`; `rejectAndLog` `52-62`). |

Wrong answers are audited as `Fail_error` — there is no distinct wrong-answer
kind in `Domain.res:12-16`.

### `handleTimeout` (`Flow.res:86-110`)

1. `Session.claim`; `None` → return, no decision (`Flow.res:87-89`).
2. `Some` → `enforceDecision(Punish_soft)` (`Flow.res:91-96`).
3. If `verificationLocation = Some(loc)` → `updateStatus("验证已超时…")` +
   `scheduleMessageCleanup(10)` (`Flow.res:98-104`).
4. `logActivity(Fail_timeout)` (`Flow.res:107`).

Timeout does **not** apply cooldown — see INV-8.

## Effect-sequence traces (happy path)

Verified by `FlowTest.res` trace assertions (`FlowTest.res:79-132`).

In-group (9 effects): `Cooldown.check → findPending → Quiz.getRandom →
restrictUser → Session.save → Session.waitAndPeek → presentChallenge →
Session.updateLocation → logActivity(Request_start)`.

Join request (8 effects): same minus `restrictUser`; `presentChallenge` targets
the user DM (`chat=42` in the test fixture).

## Invariant catalogue

Each invariant lists its assertion, what it depends on, and a concrete
violation scenario. "Holds" below means "holds in the normal operating path at
commit `83d9392`", not "holds unconditionally".

### INV-1 — Claim gate

**Assertion.** Every settlement of a live session goes through
`Session.claim`; only `Some(session)` may call `enforceDecision`, and `None`
must do nothing.

**Holds.** All terminal paths comply: callback (`Flow.res:224-268`), timeout
(`Flow.res:87-109`), challenge-send failure (`Flow.res:66-81`). `bail` punishes
without a claim, but only on no-session paths (cooldown / no quiz / old session
already claimed) (`Flow.res:129-132`).

### INV-2 — Exactly one winner per session

**Assertion.** For any set of concurrent claimants of the same session
(answer, timeout observer, duplicate click, duplicate re-armed observer), at
most one receives `Some`.

**Holds**, with backend-specific conditions documented in
[04-state-backends.md](04-state-backends.md): memory via event-loop
synchronicity (`memoryStore.ts:57-68`); sqlite via synchronous
`BEGIN IMMEDIATE` transactions (`sqliteStore.ts:90-102,147-155`); redis via
Lua (`redisStore.ts:32-44`). Contract test pins single-process behavior
(`storeContract.ts:104-114`); `FlowTest.res:451-530` pins the flow-level races
(late timeout, click after timeout, duplicate correct clicks).

### INV-3 — No double decision on the answer/timeout race

**Assertion.** A session is never both granted and punished.

**Holds as a consequence of INV-1/INV-2.** The loser path produces either a
silent observer no-op (`Flow.res:118-119`) or an "expired" click acknowledgement
(`Flow.res:226`, `213-215`).

### INV-4 — Session and indexes are created and removed together

**Assertion.** `save` creates the session plus every option-token index and the
pending lookup; `claim` removes all of them; `updateLocation` never re-creates
a claimed session.

**Holds in the happy path; fails under specific conditions:**
- Redis `save` is a non-transactional pipeline whose per-command results are
  ignored (`redisStore.ts:80-96`). A partial write can leave a session without
  its `rel` index list, after which claim deletes only the session and leaves
  orphan token/pending keys (`redisStore.ts:35-42`). See 04, F2.
- `updateLocation` is update-if-present in all real backends
  (`memoryStore.ts:69-75`, `sqliteStore.ts:156-162`, `redisStore.ts:114-121`),
  pinned by `storeContract.ts:130-140`. The mock does **not** check existence
  (`MockInterpreter.res:253-257`), so the Flow layer itself provides no
  resurrection protection.

### INV-5 — Pending-lookup uniqueness per entrant

**Assertion.** At most one live session exists for a `(chatId, userId)` pair.

**Mapping level: holds.** `save` overwrites the pending lookup
(`memoryStore.ts:42`), sqlite returns newest row by rowid
(`sqliteStore.ts:69-71`), redis overwrites the pending key
(`redisStore.ts:95`).

**Session level: fails under concurrent starts.** `findPending` and `save` are
a TOCTOU pair (`Flow.res:138` vs `176`) with no per-entrant lock or unique
constraint. Two concurrent `startVerification` calls can both see `None` and
both save, producing two live sessions, two challenges, two observers, and two
independent settlements (double kick/decline). On memory/redis, claiming the
older session then deletes the pending mapping that now points at the newer
session (`memoryStore.ts:65`, `redisStore.ts:36-39`); sqlite is unaffected
because claim deletes by id (`sqliteStore.ts:151-152`). Verified by probe:
after `save(s1); save(s2)` for the same key, `findByToken(s1.token)` still
returns `s1` and `claim(s1)` succeeds in memory and sqlite.

### INV-6 — The timeout observer guarantees termination

**Assertion** (stated strongly in `docs/design.md:81`). A pending session
always terminates.

**Holds only when**: `save` succeeded, the observer was armed, the process
stays up, the backend answers, and `waitAndPeek`/`claim` do not reject.

**Violation scenarios:**
1. **Restrict → save gap.** In-group restriction happens before `save`
   (`Flow.res:172-176`). If `save` rejects, `dp.onError` only logs
   (`main.ts:45-48`): the user is restricted, no session exists, no observer
   exists, and restart recovery has nothing to list.
2. **Observer chain rejection.** `session_waitAndPeek` calls `getById`
   (`state.ts:41-52`) and `session_claim` calls the store (`state.ts:85-86`);
   both can reject (redis network error, sqlite I/O error). Because the chain
   is discarded with no catch (`Flow.res:112-122`), a rejection becomes an
   unhandledRejection and `main.ts:29-32` exits the process. A probe with a
   rejecting `waitAndPeek` confirmed the unhandled rejection.
3. **Restart near TTL expiry.** See "Restart recovery" below.
4. **memory backend.** Sessions do not survive restart at all, so recovery
   cannot re-arm observers; already-restricted users stay restricted.

### INV-7 — Fail-closed directions

**Assertion.** Failure defaults to the safe side: no bypass on actor lookup
failure; no restriction before quiz availability; challenge send failure
settles as failure.

**Holds**, with one exception:
- `joinPolicy.ts:10-19` returns `false` on lookup error → verification runs.
- Quiz availability is checked before `restrictUser` (`Flow.res:149-174`).
- `presentChallenge = None` → claim then `Punish_soft` (`Flow.res:195`,
  `66-81`).
- **Exception (fail-open):** the wrong-answer path claims first, then applies
  cooldown, then punishes (`Flow.res:224-262`). If `Cooldown.apply` rejects,
  the chain stops: the session is already gone and the punishment is skipped.

### INV-8 — Cooldown semantics

**Assertion.** A wrong answer produces a cooldown; other settlements do not.

**Holds in code, undocumented as policy.** Wrong answer applies 60s
(`Flow.res:251-255`); timeout and challenge-send failure do not
(`Flow.res:86-110`, `66-81`). `docs/design.md` never defines when cooldown
applies. Consequence: for `Join_request`, a timeout only declines the request
(`interaction.ts:159-165`) and the entrant can immediately request again.

### INV-9 — Valid quiz data

**Assertion.** Every quiz has `0 <= correctOptionIndex < length(options)`.

**Does not hold by construction.** `parseQuizzes` maps fields without
validation (`quizSource.ts:25-32`); `prepareQuiz` dereferences
`Array.getUnsafe(withTokens, quiz.correctOptionIndex)` (`Flow.res:26-27`). An
out-of-range index throws before `save` (before any restriction), and the
dispatcher logs the handler error; the entrant receives no decision and the
join request stays pending.

### INV-10 — Audit integrity

**Assertion.** LOG_PEER events reflect the real lifecycle: `REQUEST_START`
precedes terminal events; `SUCCESS`/`FAIL_*` mean the decision was actually
enforced.

**Fails in two ways:**
1. `updateLocation` on an already-claimed session is a silent no-op, but the
   main chain unconditionally logs `Request_start` afterwards
   (`Flow.res:192-194`). A very fast correct click, or `presentChallenge`
   taking longer than 60s, logs `SUCCESS`/`FAIL_TIMEOUT` before
   `REQUEST_START`.
2. `interaction_enforceDecision` swallows Telegram errors
   (`interaction.ts:168-170`), yet the chain logs `Success`/`Fail_timeout`/
   `Fail_error` as if the decision happened. The audit event and the actual
   Telegram state can disagree; only Sentry/console records the enforcement
   error.

## Race and interleaving matrix

`cl(s)` = claim of session `s`; `O(s)` = its deadline observer.

| Interleaving | Outcome | Evidence |
| --- | --- | --- |
| answer wins, then observer fires | observer peek sees `None` → no-op | `Flow.res:114-121`; `FlowTest.res:467-487` |
| observer claims first, then click | `findByToken` `None` → expired ack, no grant | `Flow.res:211-215`; `FlowTest.res:489-509` |
| simultaneous answer/timeout claims | backend atomicity: one `Some`, one `None` | `memoryStore.ts:57-68`, `sqliteStore.ts:147-155`, `redisStore.ts:32-44` |
| duplicate correct clicks | first claims; second sees token gone → expired ack | `FlowTest.res:511-530` |
| wrong then correct click | first claim wins; second is "expired" | `Flow.res:224-268` |
| foreign user clicks | no claim; session survives | `Flow.res:217-219`; `FlowTest.res:347-367` |
| concurrent starts (same entrant) | two sessions, two challenges, two settlements; memory/redis old-claim can delete new pending | TOCTOU `Flow.res:138`/`176`; probe; 04-F1 |
| claim vs `updateLocation` | real backends never resurrect; `Request_start` can still be logged late | `memoryStore.ts:69-75`, `sqliteStore.ts:156-162`, `redisStore.ts:114-121`; `Flow.res:193-194` |
| callback vs restart re-arm | harmless per session: listAll excludes claimed; double observers are arbitrated by claim | `main.ts:169-172`; `Flow.res:87-89` |
| observer rejects | unhandledRejection → `exit(1)` | probe; `Flow.res:112-122`; `main.ts:29-32` |

## Restart recovery semantics

`main.ts:169-172` lists all live sessions **after** login and re-arms one
observer per session. `state.ts:18` gives each saved session a 5-minute TTL.

- With sqlite/redis, sessions survive a restart, but observers are in-process
  only, hence the re-arm loop.
- Double-arming is harmless **per session** because all terminal paths claim
  (`Flow.res:87-89`), and recovery lists live sessions only.
- **Deadline drift:** the re-armed observer waits a full 60s from boot, not
  from the original save. If recovery happens at save-time + 4:01 or later,
  the session TTL expires before the re-armed observer fires; `waitAndPeek`
  returns `None` and the entrant is never settled — a restricted entrant stays
  restricted, a join request stays pending.
- **memory backend:** `listAll()` is empty after restart; nothing is re-armed.
  With the default `STATE_BACKEND=memory` (`env.ts:7,43`) and
  `restart: always` (`docker-compose.yaml:6`), every restart silently abandons
  all in-flight sessions.

## Discrepancies with `docs/design.md`

| design.md claim | Code reality |
| --- | --- |
| "Timeout observers guarantee a pending session always terminates" (`design.md:81`) | Overstated — fails in the restrict→save gap, on observer-chain rejection, near TTL expiry, and for memory backend (INV-6). |
| "`dp.onError` … the flow's timeout observer resolves any half-finished session" (`design.md:85-87`) | Only if the session was saved and the observer armed before the error. |
| "nobody stays restricted forever" via restart recovery (`design.md:91-94`) | Not true for memory backend; not true for persistent backends when recovery happens near TTL expiry. |
| Logging must never break the verification chain (`design.md:82-83`) | Holds for LOG_PEER Telegram calls (`interaction.ts:181-200`), but the observer chain itself can break the process (INV-6.2). |
| Cooldown behavior | Not defined in design.md, so the timeout/send-failure asymmetry (INV-8) is undocumented. |
