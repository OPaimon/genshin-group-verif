# Errors, Logging, and Observability

This is the P1 reference for the error-handling strategy and the three logging
surfaces: **console**, **Sentry**, and **LOG_PEER** (the Telegram audit
channel). The surfaces are deliberately not interchangeable
(`design.md:98-104`).

## Error handling strategy by layer

| Layer | Policy | Where |
| --- | --- | --- |
| Pure state machine (`Flow.res`) | No try/catch of its own. Assumes `InteractionSig` effects never reject and lets `StateSig`/`QuizSourceSig` rejections propagate to the dispatcher. The discarded observer chain is *required* to never reject. | `Flow.res:112-113` |
| Telegram adapter (`interaction.ts`) | Every method catches Telegram errors; only `presentChallenge` converts failure into a domain value (`None`); everything else logs and resolves. | `interaction.ts:47-57,75-102,118-120,168-170,197-199,216-218,229,264-266` |
| State facade/backends | No catches. Backend errors reject up to the caller. | `state.ts:41-95`, backends |
| Dispatcher | `dp.onError` logs the handler error, returns `true` (handled), so a throwing handler does not become an unhandled rejection. | `main.ts:45-48` |
| Process | `uncaughtException`/`unhandledRejection` → log → flush Sentry → `exit(1)`. Docker `restart: always` restarts. | `main.ts:24-32`, `docker-compose.yaml:6` |
| Quiz startup | Failure to load the quiz file logs an error and installs an empty bank; the bot keeps running and every new verification bails as "service unavailable". | `quizSource.ts:44-52` |

The interaction adapter's "never reject" guarantee is the load-bearing rule for
the Flow effect chain; it exists only as comments
(`interaction.ts:176-179`, `Flow.res:112-113`), not in the ReScript signature.

## Three-surface matrix

| Event type | Console | Sentry | LOG_PEER |
| --- | --- | --- | --- |
| `logger.debug` / `logger.info` | yes | **no** | no |
| `logger.warn` | yes | yes (warning-level event) | no |
| `logger.error` | yes | yes (exception if an `Error`, else error message) | no |
| Verification lifecycle (`REQUEST_START`, `SUCCESS`, `FAIL_TIMEOUT`, `FAIL_ERROR`) | yes, via `logger.info` with raw numeric IDs (`interaction.ts:184`) | no | yes, with `#GID`/`#UID` and entrant first name (`interaction.ts:186-196`, `messages.ts:38-48`) |
| Benign `MESSAGE_NOT_MODIFIED` | silent | silent | no |
| `REPLY_MARKUP_INVALID` during status edit | silent after successful retry | only if retry also fails (`interaction.ts:87-100`) | no |
| Timed message-cleanup delete failure | `debug` | no | no |
| LOG_PEER send failure | `error` | yes | no |
| Actor-lookup failure in admin bypass | `warn` (no raw IDs) | yes | no |
| Redis close failure | `warn` | yes | no |
| Crash | `error` + flush | yes | no |

### Level policy in code

`logger.ts:40-59`: `debug`/`info` are console-only; `warn`/`error` add Sentry
via `captureError`. `splitError` (`logger.ts:24-38`) pulls the first `Error`
out of the argument list: with an `Error`, Sentry gets an exception plus
`extra.logger_message` (the remaining context); without one, it gets a
`captureMessage` whose text folds in the context.

The three deliberately swallowed, still-recorded cases are documented in
`design.md:112-116` and match the code: joinPolicy lookup failure → `warn`
(`joinPolicy.ts:17`), redis close failure → `warn` (`redisStore.ts:147`),
message-cleanup delete failures → `debug` (`interaction.ts:214,229`).

### Call-site inventory

`logger.warn`: `joinPolicy.ts:17`, `redisStore.ts:147`.
`logger.error`: `quizSource.ts:49,67`; `interaction.ts:55,96,101,119,169,198,217,265`;
`main.ts:25,30,46`. All current warn/error context strings avoid raw IDs
(`joinPolicy.ts:16` calls this out explicitly). Raw IDs appear only on
console-only paths: `main.ts:72,90,120,126`, `interaction.ts:184`.

## Sentry configuration and PII audit

`sentry.ts:55-73`: opt-in via `SENTRY_DSN`; error monitoring only
(`tracesSampleRate: 0`); disabled integrations `Console`,
`LocalVariablesAsync`, `OnUncaughtException`, `OnUnhandledRejection`
(`sentry.ts:21-26`, matching the names of the installed @sentry/node default
integrations). The crash handlers in `main.ts` are the single owner of the
exit policy.

Privacy scrubbing:

- `TELEGRAM_ID_PATTERN = /\b-?\d{7,13}\b/g`; matches are replaced by a
  truncated SHA-256 (`sentry.ts:28-36`).
- `sanitizeEvent` scrubs `event.message` and every `exception.value`
  (`sentry.ts:43-52`). Stack frames are untouched, by design.
- Console and local-variable integrations are disabled so ordinary logging and
  local variables cannot leak into events (`sentry.ts:10-12`).

**Gap — `extra.logger_message` is not scrubbed.** When `logger.error` receives
an `Error`, `captureError` attaches the remaining context as
`extra.logger_message` (`sentry.ts:95-99`); `sanitizeEvent` never touches
`event.extra`. Current call sites keep raw IDs out of warn/error context, so
today's events are clean, but the second line of defence described in
`design.md:130-131` ("beforeSend additionally scrubs … event messages and
exception values") does not cover extras. A future
`logger.error(\`user=\${id}\`, err)` would leak the raw ID to Sentry.

Also note: `describe` is duplicated in `logger.ts:14-22` and
`sentry.ts:75-84` with slightly different `undefined` behavior (`String(undefined)`
vs `''`).

## Swallowed-error inventory and consequences

| Swallowed error | Consequence | Location |
| --- | --- | --- |
| `presentChallenge` send failure | becomes `None` → Flow settles as failure. Correct. | `interaction.ts:54-57` |
| `updateStatus` failure | UI only; settlement already decided. Low impact. | `interaction.ts:75-102` |
| `acknowledgeClick` failure | toast missing; user may see a spinner. Low impact. | `interaction.ts:118-120` |
| **`enforceDecision` failure** | The session is already claimed and the flow still logs `Success`/`Fail_*`. A verified entrant can stay restricted, or a failed entrant can stay in the group; no retry or compensation exists. | `interaction.ts:168-170`, `Flow.res:232-245,258-262` |
| `logActivity` failure | Audit entry lost; only console/Sentry knows. Flow unaffected. | `interaction.ts:197-199` |
| `sendTempMessage` failure | Notice missing; punishment still follows. Low impact. | `interaction.ts:216-218` |
| cleanup delete failure | stale message until Telegram cleanup. Low impact. | `interaction.ts:229`, `214` |
| `restrictUser` failure (basic group, etc.) | No mute; verification still presented and settled by kick/decline. Documented at `design.md:84-85`. | `interaction.ts:264-266` |
| quiz load failure | empty bank → every verification bails "service unavailable". Fail-closed for new entrants, but no self-heal until `/reload` or restart. | `quizSource.ts:48-51` |

## Crash policy and the detached observer

`main.ts:24-32` installs the two crash handlers **after** `await initSentry()`
(`main.ts:17`). Both log, flush Sentry with a 2s timeout, then `exit(1)`.
Sentry's own exception-handler integrations are disabled so this stays the
single exit owner (`sentry.ts:14-16`).

The verification flow deliberately forks the timeout observer and discards its
Promise (`Flow.res:112-122`). The discarded chain calls
`session_waitAndPeek` → `getById` (`state.ts:41-52`) and then `session_claim`
(`Flow.res:87`, `state.ts:85-86`); both can reject on backend errors.

**Verified probe:** a `waitAndPeek` implementation that rejects was substituted
into `Flow.Make`, and `armTimeoutObserver` was invoked. Node emitted an
unhandled rejection — which, in production, `main.ts:29-32` turns into
`exit(1)`. A transient Redis/SQLite error 60 seconds after a challenge can
therefore crash the bot; with `restart: always` and a persistent backend it
recovers and re-arms, but with the default memory backend every in-flight
session is lost.

## Audit integrity caveats

LOG_PEER is the audit surface, but two situations make audit entries diverge
from reality:

1. **Enforcement failure still logs success/failure.** `enforceDecision`
   swallows the Telegram error (`interaction.ts:168-170`), then Flow logs the
   lifecycle event (`Flow.res:244,262,107`). A `SUCCESS` entry does not prove
   the restriction was lifted.
2. **Late `REQUEST_START`.** `updateLocation` on an already-claimed session is
   a no-op but returns `unit`; Flow still logs `Request_start`
   (`Flow.res:192-194`). Fast correct clicks or a >60s challenge send produce
   `SUCCESS`/`FAIL_TIMEOUT` before `REQUEST_START`, and the late challenge
   message is never cleaned up (the timeout path saw
   `verificationLocation = None`).
3. Wrong answers are tagged `FAIL_ERROR` (`Flow.res:259-262`) — the same tag as
   challenge-send failure (`Flow.res:78`). The four-value `log_kind`
   (`Domain.res:12-16`) cannot distinguish them.

## Recommendations summary

1. Attach `.catch` to the discarded observer chain (or catch inside
   `state.ts`) so the safety net can never become an unhandled rejection.
2. Make `enforceDecision` failure visible to the Flow (e.g. return a result),
   and decide a compensation policy (retry/alert); at minimum, log a distinct
   audit tag when enforcement failed.
3. Return a boolean from `updateLocation` and log `Request_start` only when the
   session was still live.
4. Extend `sanitizeEvent` to scrub `extra.logger_message`, or stop attaching
   context as extra.
5. Merge the duplicated `describe` behavior in `logger.ts`/`sentry.ts`.
