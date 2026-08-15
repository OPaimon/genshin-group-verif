# Deepening Opportunities

This is the required deepening-opportunities list produced from the
full-repository survey. It follows the improve-codebase-architecture line of
questioning (where is the interface nearly as complex as the implementation,
where does locality leak, what would concentrate complexity) and uses the
codebase-design vocabulary exactly: **module**, **interface**, **seam**,
**adapter**, **depth**, **leverage**, **locality**.

All suggestions are analysis output. This analysis does not implement them and
does not modify business code.

## How to read a candidate

| Field | Meaning |
| --- | --- |
| Interface | What a caller/tester must know today to use the module — the surface a deepening would shrink or clarify. |
| Seam | Where the interface lives; where behavior could be altered without editing callers. |
| Depth gap | Why the module is shallower than it looks: hidden contracts, duplicated knowledge, or pass-through layers. |
| Leverage | What callers/tests gain: one implementation pays back across N call sites. |
| Locality | What maintainers gain: the change/bug/knowledge concentrates in one place. |
| Strength | `Strong` / `Worth exploring` / `Speculative`. |

## Strong candidates

### D-01 — Make the AppBridge binding names a checked, generated contract

- **Files**: `src/AppBridge.res:3-68`; `src/interpreter/state.ts:5-6`;
  `src/interpreter/interaction.ts` exports; `src/interpreter/quizSource.ts`
  exports.
- **Interface**: ~20 string literals (`"interaction_presentChallenge"`, …),
  parameter order/arity, and the `Domain.gen.tsx` type mapping — invisible to
  both compilers. `state.ts:5-6` already says "keep them stable", i.e. the
  contract is discipline.
- **Seam**: the ReScript ↔ TypeScript language seam at `AppBridge.res`.
- **Depth gap**: `AppBridge.res` is 134 lines of pure forwarding with a large
  hidden interface; a rename on either side fails at runtime as
  `undefined is not a function`.
- **Leverage**: every future change to the interpreters, domain types, or
  bridge gets caught by a manifest/generated binding or a binding-conformance
  test instead of production.
- **Locality**: the name/arity/type contract lives in one artifact instead of
  three files that must agree by hand.
- **Solution**: a small manifest or codegen that emits both the ReScript
  externals and the TS export names, plus a `node --test` that imports each TS
  module and asserts every bound name exists. Optionally collapse the TS side
  to a single exported object the bridge calls structurally.
- **Strength**: Strong. This is the foundation under every other
  cross-language candidate.

### D-02 — Collapse the state double surface; move restart recovery behind `StateSig`

- **Files**: `src/interpreter/state.ts:20-95`; `src/interpreter/state/store.ts:16-55`;
  `src/StateSig.res:6-27`; `src/main.ts:11,169-172`.
- **Interface**: two near-parallel interfaces (`StateSig.S` and `StateStore`)
  for one concept; `main.ts` bypasses the ReScript seam to call
  `stateStore().session.listAll()`.
- **Seam**: the persistence seam should be exactly `StateSig.S` ↔ the store
  adapter, not a third half-transparent facade.
- **Depth gap**: every store-touching facade method is a one-line delegate
  and only `waitAndPeek` contains behavior; `listAll`/`getById` exist only on
  the TS side, so recovery cannot be tested through `Flow.Make`.
- **Leverage**: adding `listAll` to `StateSig.S` and a
  `Flow.recoverPendingSessions` entry lets the pure core own recovery; tests
  gain the same surface production uses.
- **Locality**: TTL constant, key derivation, waitAndPeek, and recovery policy
  concentrate in one layer.
- **Solution**: make `StateStore` the single interface the facade exports (or
  generate both sides from one definition), and move `main.ts:169-172`'s loop
  into `Flow.Make` via the signature.
- **Strength**: Strong.

### D-03 — Unify the interaction adapter's error policy and put it in the interface

- **Files**: `src/interpreter/interaction.ts:47-57,63-103,109-121,128-171,181-199,208-231,238-266`;
  `src/InteractionSig.res:7-39`.
- **Interface**: eight methods whose real contract is "never reject, except
  `presentChallenge` signals failure via `None`" — documented only in
  comments (`interaction.ts:176-179`, `Flow.res:112-113`).
- **Seam**: `InteractionSig.S`; the never-reject invariant is part of the
  interface whether or not the signature says so.
- **Depth gap**: the error policy is duplicated across eight try/catch blocks
  with subtly different benign cases; adding a ninth Telegram call invites a
  copy-paste policy bug.
- **Leverage**: one `telegramCall`/`swallow` helper serves all call sites and
  can be tested once; `Flow.Make` callers keep relying on the same guarantee.
- **Locality**: level policy, benign-error handling, and logging for Telegram
  failures live in one place.
- **Solution**: internal helper `safeCall(name, fn, {fallback})` plus explicit
  `// never rejects` contract text on each `InteractionSig.S` method; keep the
  genuinely different branches (`presentChallenge` returns `option`,
  `updateStatus` retries) as small specializations.
- **Strength**: Strong.

### D-04 — Make the discarded observer chain structurally unable to reject

- **Files**: `src/Flow.res:112-122`; `src/Utils.res:16`; `src/interpreter/state.ts:41-53,85-86`;
  `src/main.ts:29-32`.
- **Interface**: `armTimeoutObserver` returns `unit` today; its hidden
  interface includes "the discarded promise must never reject".
- **Seam**: the fork point between the main effect chain and the safety net.
- **Depth gap**: the safety net has no failure path — a backend rejection
  becomes an unhandled rejection (verified by probe) and the process exits.
- **Leverage**: one `.catch` (or an `observeTimeout` helper inside
  `Flow.Make`) protects every armed session and removes a whole crash class.
- **Locality**: observer failure policy sits next to the fork that creates it.
- **Solution**: bind the observer chain through a catch that logs
  `[Observer] …` and resolves; add a Flow test with a rejecting mock to pin
  it.
- **Strength**: Strong (this is also R-07 in the risk register).

### D-05 — Give `StateStore` an atomic pending-slot save (claim old on save)

- **Files**: `src/interpreter/state/store.ts:23-29`; `src/Flow.res:134-176`;
  `memoryStore.ts:35-43,59-68`; `sqliteStore.ts:125-133,147-155`;
  `redisStore.ts:80-96,32-44`.
- **Interface**: `save` currently promises "newer wins" but silently leaves
  the older session fully claimable; caller-side cleanup (`Flow.res:141-145`)
  is a TOCTOU patch, not a guarantee.
- **Seam**: the persistence seam is the only place with native atomicity per
  backend — the entrant-uniqueness invariant belongs there.
- **Depth gap**: per-entrant uniqueness is a domain invariant implemented
  partly in `Flow` and partly nowhere; the deletion test shows it would
  concentrate in the store.
- **Leverage**: every caller of `save` (Flow today, future recovery/migration
  paths) gets the invariant for free; the double-session race disappears.
- **Locality**: claim-old-on-save and conditional pending deletion live inside
  each adapter next to claim.
- **Solution**: rename to `savePending` with the contract "atomically remove
  any live session with the same lookup key, then insert"; implement with
  memory sync check, sqlite transaction, Redis Lua. Fix the blind pending
  delete in `claim` too (F1 in 04).
- **Strength**: Strong.

### D-06 — Make quiz loading total: validate at the boundary, not in the state machine

- **Files**: `src/interpreter/quizSource.ts:13-38,60-69`; `src/Flow.res:24-30`;
  `src/Domain.res:68-73`.
- **Interface**: `quiz` is a record whose `correctOptionIndex` validity is an
  unstated precondition; `getRandom`/`reload` don't expose validation
  failures.
- **Seam**: `QuizSourceSig.S` — the adapter that owns the file format should
  own format correctness.
- **Depth gap**: `prepareQuiz`'s `Array.getUnsafe` (`Flow.res:27`) means a bad
  file throws inside the pure core, where no validation lives.
- **Leverage**: one validation function protects startup, `/reload`, and every
  future quiz source (DB, API).
- **Locality**: file-format knowledge stays in `quizSource.ts`; `Flow` can
  trust `Some(quiz)`.
- **Solution**: validate `CorrectOptionIndex ∈ [0, options.length)` and
  non-empty options on load/reload; return `Error` with the quiz id on reload;
  add tests for invalid data.
- **Strength**: Strong.

### D-07 — Let enforcement results flow back into the state machine

- **Files**: `src/interpreter/interaction.ts:128-171`; `src/InteractionSig.res:22-27`;
  `src/Flow.res:228-245,258-262,91-107`.
- **Interface**: `enforceDecision` returns `unit` and swallows errors, so the
  pure core cannot distinguish "enforced" from "failed".
- **Seam**: `InteractionSig.S` at the enforcement method — the place where
  Telegram reality re-enters the domain.
- **Depth gap**: the state machine performs settlement bookkeeping (audit,
  cleanup) as if enforcement always succeeded; compensation logic has nowhere
  to live.
- **Leverage**: a `result`/boolean return lets Flow decide retry, distinct
  audit tags, and future compensation for all five call sites at once.
- **Locality**: enforcement failure policy concentrates in Flow instead of
  being split between a swallowed log and optimistic audit entries.
- **Solution**: change `enforceDecision` to return a status (or
  `result<unit, string>`), thread it through Flow terminal paths, and tag
  LOG_PEER accordingly.
- **Strength**: Strong.

## Worth exploring

### D-08 — Single source for the `chat:user` lookup key

- **Files**: `src/interpreter/peer.ts:6-8`; `src/interpreter/state/store.ts:87-89`;
  `src/MockInterpreter.res:79-80`; `src/FlowTest.res:135,344`.
- **Interface**: key format is an implicit invariant of both indexes and
  cooldowns, re-implemented in TS and in the mock.
- **Seam**: `Domain.Peer` — the type that owns peer ids should own their
  composite key.
- **Depth gap / Leverage / Locality**: one generated function replaces three
  hand-kept implementations; tests stop hard-coding `"-100:42"`.
- **Strength**: Worth exploring.

### D-09 — Consolidate terminal-settlement paths inside `Flow.Make`

- **Files**: `src/Flow.res:38-49,51-62,66-81,86-110,224-268`.
- **Interface**: the four terminal paths share the same claim →
  UI/enforcement → cleanup → audit skeleton but re-implement it.
- **Seam**: an internal, private seam inside `Flow.Make` (no external
  interface growth).
- **Depth gap / Leverage / Locality**: a `settle(session, …)` helper would
  make the claim gate and effect order impossible to diverge across paths.
- **Strength**: Worth exploring.

### D-10 — Inject the Telegram client and quiz loader (accept dependencies)

- **Files**: `src/interpreter/runtime.ts:3-13`; `src/interpreter/quizSource.ts:21-23`;
  `src/interpreter/interaction.ts`; `src/main.ts:51-52`.
- **Interface**: global `_tg` and a hardcoded cwd-relative quiz path are
  hidden parameters of every call.
- **Seam**: module construction — factories (`createInteraction(client)`,
  `createQuizSource(path, readFile)`) would create the seam tests need.
- **Depth gap / Leverage / Locality**: the entire interaction adapter is
  currently untestable; one injection point unlocks fake-client tests for all
  eight methods.
- **Strength**: Worth exploring.

### D-11 — Upgrade the mock to the Promise monad and programmable observers

- **Files**: `src/MockInterpreter.res:141-145,259-262,253-257`; `src/FlowTest.res`.
- **Interface**: the test seam (`Flow.Make`'s three signatures) is instantiated
  with a monad that cannot represent await interleaving or rejection.
- **Seam**: the mock adapter itself.
- **Depth gap / Leverage / Locality**: an async mock (or failure-injection
  flags) would let Flow tests cover the observer's `Some` path, rejection
  handling, and claim/updateLocation races that are currently invisible.
- **Strength**: Worth exploring.

### D-12 — Pin TTL semantics in the conformance suite

- **Files**: `src/interpreter/state/storeContract.ts:116-140`;
  `memoryStore.ts:69-75`; `sqliteStore.ts:156-162`; `redisStore.ts:114-121`.
- **Interface**: `updateLocation` says "refresh the TTL" but the three
  adapters refresh different key sets.
- **Seam**: the shared contract — the cheapest place to make the three
  adapters honest.
- **Depth gap / Leverage / Locality**: add TTL-advancement tests (and either
  refresh indexes everywhere or narrow the contract wording); one contract
  change verifies three adapters.
- **Strength**: Worth exploring.

## Speculative

### D-13 — Extract pure update→domain-input mappings from `main.ts`

- **Files**: `src/main.ts:86-156`; `src/interpreter/peer.ts:3-4`.
- **Interface**: mtcute update types → `start_input`/`callback_input`; today
  hand-rolled and double-cast (`main.ts:147-151`) at the composition root.
- **Seam**: pure functions `updateToStartInput`, `updateToCallbackInput`
  (testable, side-effect-free).
- **Strength**: Speculative — low risk, but also lower leverage than D-01.

### D-14 — Merge the duplicated error-description behavior of logger/sentry

- **Files**: `src/logger.ts:14-38`; `src/sentry.ts:75-107`.
- **Interface**: two `describe` implementations with different undefined
  behavior, plus error classification split across modules.
- **Seam**: `captureError` is already the seam; give it ownership of
  description/classification.
- **Strength**: Speculative.

## Top recommendation

**Start with D-01 (checked AppBridge bindings).** Every other deep module in
this repository — Flow, the state adapters, the interaction adapter — is
reached through that name-string seam, and today neither compiler can see a
broken binding. It is the smallest change with the broadest leverage: after
it, renames and signature drift become test failures instead of production
crashes, and the deeper candidates (D-02, D-03, D-07) have a stable foundation.

The **most urgent safety fix** (not the best deepening) is D-04 / risk R-07:
attach a rejection handler to the discarded observer chain, because that path
turns a transient backend error into a process exit.

## Explicit non-goals

- No candidate is implemented here; this repository's business code is
  untouched by this analysis.
- Candidates marked `Worth exploring`/`Speculative` are not commitments.
- D-05 would move an invariant from `Flow` into the store; it does not
  contradict [ADR-0001](../adr/0001-claim-first-settlement.md) — it strengthens
  the same claim-first rule at save time.
- No candidate contradicts an existing ADR.
