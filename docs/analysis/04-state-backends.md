# State Backends and Claim Atomicity

This is the P0 reference for the three `StateStore` adapters
(memory / sqlite / redis) and the claim semantics the whole flow depends on.
Claim-first settlement is [ADR-0001](../adr/0001-claim-first-settlement.md).

All line references are to commit `83d9392`.

## StateStore contract

`store.ts:16-55` defines the interface. The design deliberately exposes
composite operations, not raw KV primitives (`store.ts:1-10`), so that
claim's all-or-nothing removal can live inside each backend next to its native
atomicity primitive.

| Area | Method | Semantics |
| --- | --- | --- |
| Cooldown | `check(key)` | true if `key` currently cooling down (`store.ts:17-18`). |
| Cooldown | `apply(key, ttlMs)` | write/refresh cooldown with TTL (`store.ts:19`). |
| Session | `save(s, ttlMs)` | write session + every option-token index + pending lookup, each with TTL. A second save for the same lookup key makes the newer session pending (`store.ts:23-29`). |
| Session | `getById(id)` | live session or `undefined` (`store.ts:30`). |
| Session | `findByToken(token)` | session via any option token (`store.ts:31`). |
| Session | `findPending(lookupKey)` | pending session or `undefined` (`store.ts:32`). |
| Session | `claim(id)` | atomically remove session + **all** index entries and return it; exactly one concurrent claimant gets the session, the rest get `undefined` (`store.ts:33-38`). |
| Session | `updateLocation(id, loc, ttlMs)` | set `verificationLocation` and refresh TTL **only if live**; never an upsert (`store.ts:39-45`). |
| Session | `listAll()` | all live sessions, for restart recovery (`store.ts:46-47`). |
| Store | `close()` | release timers/handles/connections; store unusable afterwards (`store.ts:53-54`). |

Serialization: sessions are JSON-safe; `SessionEnvelope` precomputes the
lookup key so the Redis Lua script never re-derives numeric peer ids
(`store.ts:62-85`).

## Per-backend layout and atomicity

### memory (`memoryStore.ts`)

- Four `TTLMap`s: `sessionById`, `tokenIndex`, `lookupIndex`, `cooldownMap`
  (`memoryStore.ts:15-23`); `TTLMap` expires lazily on access and sweeps every
  60s (`ttlMap.ts:9-14,21-29,58-65`).
- `claim` performs lookup + token deletes + lookup delete + session delete with
  **no `await` between them** (`memoryStore.ts:57-68`). The whole body runs as
  one event-loop step; concurrent JS claimants serialize.
- Atomicity condition: no `await` may ever be inserted between the lookup and
  deletes, and the store must not be shared across processes/workers. Each
  process has its own maps, so multi-process memory deployment cannot arbitrate
  claims at all.
- `close()` only disposes the sweep timers (`memoryStore.ts:80-85`); the maps
  remain readable/writable, contrary to the `store.ts:53-54` "unusable
  afterwards" wording (`ttlMap.ts:53-55`).

### sqlite (`sqliteStore.ts`)

- `node:sqlite` `DatabaseSync`, WAL mode (`sqliteStore.ts:50-51`). Schema:
  `sessions(id PK, lookup_key, data JSON, expires_at)`,
  `session_tokens(token PK, session_id, expires_at)`,
  `cooldowns(key PK, expires_at)` (`sqliteStore.ts:26-44`).
- Reads filter `expires_at > now`; a 60s sweep physically removes expired rows
  (`sqliteStore.ts:60-88,107-112`). `listAll` itself filters, so sweep is only
  GC.
- `tx()` is `BEGIN IMMEDIATE → fn → COMMIT`, `ROLLBACK` on throw
  (`sqliteStore.ts:90-102`). All statements are synchronous.
- `save` runs session insert + all token inserts in one transaction
  (`sqliteStore.ts:125-133`). `claim` runs `SELECT … WHERE id AND
  expires_at > now` then deletes tokens and the session row in the same
  transaction (`sqliteStore.ts:147-155`).
- Pending lookup is not a table: `findPending` orders live rows by `rowid DESC`
  (`sqliteStore.ts:69-71`). Claim by id therefore cannot delete another
  session's pending mapping.
- `updateLocation` refreshes only the `sessions` row (`sqliteStore.ts:156-162`);
  token rows keep their original expiry.
- **Busy handling:** `new DatabaseSync(path)` is constructed without a busy
  timeout (`sqliteStore.ts:50`); the default is `0`, so a competing writer
  makes `BEGIN IMMEDIATE` throw `SQLITE_BUSY` immediately instead of waiting.
  A two-connection probe confirmed `database is locked` on concurrent
  `BEGIN IMMEDIATE`.

### redis (`redisStore.ts`)

- Key layout (prefix configurable): `sess:{id}` → envelope JSON,
  `rel:{id}` → space-separated relative index key list, `tok:{token}` →
  session id, `pending:{lk}` → session id, `cd:{lk}` → `"1"`
  (`redisStore.ts:4-9,59-63`).
- `save` uses a **pipeline**, not `MULTI/EXEC` (`redisStore.ts:80-96`), and
  ignores `pipeline.exec()` results. The write order is `sess`, `rel`,
  `tok:*`, `pending`.
- `claim` is a Lua script (`redisStore.ts:32-44`): `GET sess`; if absent
  return `false`; `GET rel`; `DEL` every index key listed in `rel`; `DEL rel`;
  `DEL sess`; return the original stored JSON. Redis executes scripts
  atomically on a single instance, and the script never parses JSON or formats
  peer ids in Lua (`redisStore.ts:11-17`).
- `updateLocation` is `GET sess` then `SET … XX PX` (`redisStore.ts:114-121`):
  the `XX` loses if claim deleted the session between the two commands.
- `listAll` is `SCAN sess:*` + `MGET`, filtering nulls
  (`redisStore.ts:124-140`); no deduplication of SCAN repeats.
- Client options: `maxRetriesPerRequest: 3` (`redisStore.ts:51`); ioredis
  default `autoResendUnfulfilledCommands: true` (ioredis 5.11.1), which matters
  for claim (F6 below).

## Consistency matrix

| Operation | memory | sqlite | redis | Divergence |
| --- | --- | --- | --- | --- |
| `save` atomicity | yes (sync) | yes (transaction) | **no** (pipeline) | partial Redis writes possible |
| `save` over same lookup key | pending points to new; old session + old tokens stay live | pending query returns new; old row + old tokens stay live | pending points to new; old session + old tokens stay live | all three leave the old session fully claimable |
| old-session claim after overwrite | **deletes pending that now points to the new session** | new session unaffected | **deletes pending that now points to the new session** | memory/redis blind key deletion (`memoryStore.ts:65`, `redisStore.ts:36-39`); sqlite deletes by id (`sqliteStore.ts:151-152`) |
| `claim` atomicity (single process) | event-loop step | synchronous transaction | Lua script | all pass the contract concurrency test |
| `claim` atomicity (multi-process) | **no** | yes if busy-timeout configured | yes on single-instance Redis | see analysis below |
| `updateLocation` TTL refresh | session only | session row only (pending query inherits; tokens do not) | session key only | tokens expire earlier everywhere; memory/redis pending too |
| `getById` expiry | lazy per-key | `expires_at` filter | native PX | same observable semantics |
| `findByToken` expiry window | token first? no — session expires first at initial save (`memoryStore.ts:36-42`) | both tables share `expires_at` at initial save (`sqliteStore.ts:127-131`) | session key set first → session expires first (`redisStore.ts:90-95`) | after `updateLocation` the refreshed session can outlive its tokens in all three |
| `listAll` | lazy cleanup, correct | always filters live rows | SCAN/MGET race handled by null filter; possible duplicates | recovery double-arms are claim-arbitrated, so duplicates are benign per session |
| `close` | maps remain usable | `db.close()` enforces unusable | quit/disconnect enforces unusable | memory violates the stated contract |

## Claim atomicity analysis

**Single process.** For all three backends the conformance suite
(`storeContract.ts:104-114`) runs five parallel `Promise.all` claims and
asserts exactly one winner; all 33 contract tests pass. The mechanisms:

- memory: no `await` inside claim → one uninterrupted step
  (`memoryStore.ts:57-68`).
- sqlite: `DatabaseSync` blocks the event loop; `BEGIN IMMEDIATE` serializes
  writers (`sqliteStore.ts:90-102,147-155`).
- redis: Redis serializes Lua script execution (`redisStore.ts:32-44`).

**Multi-process.** memory fails structurally (per-process maps). sqlite is
serialized by SQLite file locking provided the process waits on busy
(`sqliteStore.ts:50` currently does not set a busy timeout). redis is
arbitrated by the server for a single instance; the script is not
Cluster-compatible (multi-key without a hash-tag, dynamic keys not passed in
`KEYS`; `redisStore.ts:19-21` acknowledges single-instance as the intended
deployment).

**Why the green conformance test does not prove live-Redis multi-process
semantics.** The default Redis contract run uses `ioredis-mock`
(`redisStore.test.ts:19-22`), an in-process Lua interpreter: it cannot model
two bot processes, key eviction, real TTL timing, pipeline partial failure,
Cluster CROSSSLOT, or network disconnect/replay. The suite also only covers
one store instance per test.

## Divergences outside the conformance suite

### F1 (high) — old-session claim can delete the new session's pending mapping

Evidence: `memoryStore.ts:62-66` and `redisStore.ts:36-39` delete the pending
key unconditionally; `storeContract.ts:153-160` only asserts "newest wins"
after overwrite. Verified by probe for memory/sqlite: after
`save(s1); save(s2)` with the same `chat:user`, `findByToken(s1.token)`
returns `s1`, and `claim(s1)` succeeds. In memory (and by code inspection,
redis), `findPending` then returns `undefined` even though `s2` is live.
sqlite is unaffected.

Trigger: two live sessions for one entrant (concurrent starts, see
[02-behavior-and-invariants.md](02-behavior-and-invariants.md) INV-5) followed
by a click on the old challenge.

### F2 (medium) — redis `save` is non-atomic and its result is ignored

Evidence: `redisStore.ts:80-96`. A failed `SET sess` with later commands
succeeding leaves `rel`/`tok`/`pending` orphans that claim will not clean
(claim returns `false` when `sess` is missing, `redisStore.ts:33-34`). A
failed `SET rel` leaves `sess` present with no index list, and claim then
deletes only `sess` (`redisStore.ts:35-42`). Orphans persist until their TTL.

### F3 (medium) — `updateLocation` refreshes only the session entry TTL

Evidence: `memoryStore.ts:69-75`, `sqliteStore.ts:156-162`,
`redisStore.ts:114-121`. `store.ts:39-45` says "refresh the TTL" without
limiting the scope; the contract test checks only an immediate read
(`storeContract.ts:116-128`). After the original TTL passes, a refreshed
session is still reachable by `getById` while its token index (all backends)
and pending key (memory/redis) have expired. In the real Flow, `save` and
`updateLocation` are separated only by the challenge send round-trip, so the
window is normally small — but it grows with a slow `presentChallenge`.

### F4 (medium) — sqlite has no busy timeout

Evidence: `sqliteStore.ts:50` constructs `DatabaseSync` with no options; the
Node `timeout` option defaults to `0` (no wait). Multi-process writers get an
immediate `SQLITE_BUSY` exception rather than a serialized `undefined` from
claim.

### F5 (medium) — redis claim is not Cluster-safe

Evidence: no hash-tag in key names (`redisStore.ts:59-63`), dynamic `tok`/
`pending` keys not declared in `KEYS` (`redisStore.ts:32-44`), client is
`new Redis` not `Redis.Cluster` (`redisStore.ts:50-51`). Single-instance Redis
is the intended deployment (`redisStore.ts:19-21`).

### F6 (medium) — claim can be auto-resent after a connection loss

Evidence: `redisStore.ts:51` sets `maxRetriesPerRequest: 3`; ioredis 5.11.1
defaults to `autoResendUnfulfilledCommands: true`. If the Lua script executed
and deleted the session but the response was lost, the resent script sees no
session and returns `false`; the actual winner receives `undefined` and Flow
treats the click as expired (`Flow.res:226`). The user is then restricted with
no decision — the "exactly one winner" guarantee survives server-side, but the
winner may never know it won.

### F7 (low) — memory `close()` does not make the store unusable

Evidence: `memoryStore.ts:80-85` only stops timers; `ttlMap.ts:53-55` keeps
maps usable. Contradicts `store.ts:53-54`.

### F8 (low) — redis `listAll` may return duplicates

Evidence: SCAN may repeat keys across rehashes; `redisStore.ts:124-140` has no
`Set` dedupe. Recovery double-arms are arbitrated by claim, so the practical
impact is low.

### F9 (low/informational) — expiry order at initial save

Session entries are written before their indexes in memory and redis
(`memoryStore.ts:36-42`, `redisStore.ts:90-95`), so at initial save the
session expires first and `findByToken`/`findPending` can only fail closed.
sqlite shares one `expires_at` across session and token rows
(`sqliteStore.ts:127-131`). No correctness issue; only transient orphan keys.

## Experiments run

| Experiment | Result |
| --- | --- |
| `pnpm test` state suites | memory 11/11, sqlite 11/11, redis(ioredis-mock) 11/11 |
| Overwrite probe (`save(s1)` then `save(s2)`, same lookup key; then old-token lookup and old claim) | memory: old token finds `s1`, `claim(s1)` succeeds, pending for `s2` then gone. sqlite: old token finds `s1`, `claim(s1)` succeeds, `s2` still pending. redis: code inspection — same blind pending delete as memory. |
| `updateLocation` TTL probe | Not re-run here; code path and contract gap documented as F3. |
| sqlite busy probe | Two connections, concurrent `BEGIN IMMEDIATE` → immediate `database is locked`. |
| Live Redis | **Not run** — no Redis server available in the environment. Live-Redis behavior (pipeline failures, eviction, replay) is static analysis. |

## Recommendations summary

1. Make save atomic in Redis (Lua/MULTI) or check `pipeline.exec()` results
   and compensate (F2).
2. Make pending deletion conditional on the id it currently points to
   (memory `if (lookupIndex.get(lk) === claimed.id)`; Redis Lua `GET pending`
   compare before `DEL`) — F1.
3. Refresh index TTLs in `updateLocation`, or narrow the contract wording —
   F3.
4. Set a sqlite busy timeout — F4.
5. For claim, use a connection with `autoResendUnfulfilledCommands: false`
   and explicit error handling, or add an idempotent tombstone — F6.
6. Add contract tests for: old-session claim after overwrite, `updateLocation`
   TTL advancement, close-then-use, and (in CI) a live Redis run.
