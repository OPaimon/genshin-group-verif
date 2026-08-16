# Design: genshin-group-verif

This document records the design intent and observable behaviour of the
repository. It is the long-term reference for "why does it work this way" and
"what is it supposed to do". Implementation details may change; update this
document when the intent or the observable behaviour changes.

Domain vocabulary (what a *verification session* is, what *claim* means, etc.)
belongs in `CONTEXT.md` and is maintained by the domain-modeling skill — this
document does not replace that glossary.

## 1. Intent

`genshin-group-verif` is a Telegram bot that verifies humans joining a group:

- A new member (or a join request) must answer a randomly selected quiz question
  within a timeout.
- Passing removes the restriction / approves the request; failing or timing out
  rejects/kicks the user.
- Members added or approved by an admin skip verification.
- Verification state survives restarts when a persistent state backend is
  configured, and pending sessions are re-armed on boot so nobody stays
  restricted forever.

### Non-goals

- It is not a general-purpose group-management bot.
- It is not a quiz game; quizzes are only a human-check mechanism.
- It does not provide a web UI; all interaction happens through Telegram.

## 2. Architecture

```
src/main.ts                 process entry, Telegram event wiring, process crash policy
src/AppBridge.res           ReScript bridge: instantiates Flow.Make with TS effect implementations
src/Flow.res                verification state machine (start, callback, timeout, claim, decision)
src/Domain.res              domain types shared by ReScript and TypeScript (genType)
src/interpreter/            effect implementations (the "interpreter")
  interaction.ts            all Telegram interactions + their error policy
  messages.ts               user-facing text and LOG_PEER audit message formatting
  quizSource.ts             quiz bank load / hot reload from bot-data/quizzes.json
  state.ts                  state facade: store factory, cooldown, sessions, timeout observers
  state/                    memory / sqlite / redis state backends behind one contract
src/env.ts                  hand-rolled env parsing and validation
src/sentry.ts               Sentry init, PII scrubbing, capture/flush helpers
src/logger.ts               single thin logging entry point (console + Sentry sinks)
```

The core is deliberately a **pure ReScript state machine** (`Flow.res`) with
all side effects behind interfaces (`InteractionSig`, `StateSig`,
`QuizSourceSig`). The TypeScript `interpreter/` modules implement those
interfaces against mtcute. This is what makes the verification logic testable
without Telegram (`FlowTest.res` + `MockInterpreter.res`).

## 3. Verification behaviour

### Entry points

1. **Join request** (`onBotChatJoinRequest`): challenge is sent as a DM to the
   user; `userChatId` is the user.
2. **In-group join** (`onChatMemberUpdate`, `joined`/`added`, non-bot):
   challenge is sent into the group; `userChatId` is the group.
3. **Admin skip** (`wasAddedByAdmin`): if the member was added/approved by the
   creator or an admin, verification is skipped. A failed actor lookup returns
   `false` — lookup errors must never become a verification bypass.

### Session flow

1. A random quiz is chosen and an inline-keyboard challenge is sent. The
   callback token is a UUID; the answer labels carry the token.
2. The user answers via callback button. `Flow.handleCallback` resolves the
   token to a session and evaluates the answer.
3. Pass → the decision is enforced (approve join request / lift restriction).
4. Fail or timeout → the decision is enforced the other way (decline/kick or
   keep/apply restriction).
5. All decisions go through a **claim** step so concurrent triggers (answer vs.
   timeout) resolve to a single winner.

### Safety properties

- Timeout observers guarantee a pending session always terminates.
- Logging/audit side effects must never break the verification chain:
  `interaction_logActivity` catches every Telegram call.
- Basic groups cannot mute users (`restrictChatMember` throws); the error is
  swallowed and the flow still terminates through its normal decision path.
- `dp.onError` logs a handler error and marks it handled; the flow's timeout
  observer resolves any half-finished session.

### Restart recovery

With `sqlite`/`redis` backends, sessions persist across restarts but timeout
observers are in-process only. On boot, `main.ts` lists all pending sessions
and re-arms one observer per session. Double-arming is harmless because all
terminal paths claim, and only one claimer wins.

## 4. Logging and error monitoring

There are **three distinct surfaces**, and they are not interchangeable:

| Surface | Transport | What goes there |
| --- | --- | --- |
| Console | stdout/stderr → Docker logs | debug/info/warn/error for local and container debugging |
| Sentry | `@sentry/node` → sentry.io SaaS | PII-scrubbed **logs** (levels ≥ `SENTRY_LOG_LEVEL`) and **error events** (warn/error) |
| LOG_PEER | Telegram channel message | verification audit events (`#REQUEST_START`, `#SUCCESS`, `#FAIL_TIMEOUT`, `#FAIL_ERROR`, …) |

### Level policy

- `logger.debug` / `logger.info`: console + Sentry Logs when the level is at or
  above `SENTRY_LOG_LEVEL` (default `info`, so debug stays local by default).
- `logger.warn`: console + Sentry Logs + a warning-level Sentry event.
- `logger.error`: console + Sentry Logs + a Sentry exception/error event
  (exception when an `Error` is passed, otherwise an error-level message).
- Benign known cases (`MESSAGE_NOT_MODIFIED`) stay silent.
- Deliberately swallowed errors are still recorded at an explicit level:
  - `joinPolicy` lookup failure → `warn`
  - `redisStore.close` failure → `warn`
  - timed message-cleanup delete failures → `debug`

Sentry is **error monitoring + log forwarding**, not tracing or performance
monitoring (`tracesSampleRate: 0`). LOG_PEER remains the Telegram audit surface;
only a failure to send to LOG_PEER itself becomes a Sentry error event.

### Privacy policy (what may leave the server)

- Message text and any personal profile field: **never sent to Sentry**.
- Numeric Telegram IDs: **hashed** before leaving. Raw IDs in console messages
  are permitted because `beforeSend` (error events) and `beforeSendLog`
  (log messages and their structured `sentry.message.parameter.*` attributes)
  scrub them before transmission.
- The `Console` and `LocalVariables` Sentry integrations are disabled so
  breadcrumbs and local variable inspection cannot leak data into events.
  (`ConsoleLogs` is the separate, deliberately enabled integration.)
- Warn/error event messages do not embed raw IDs.

### Crash policy

- `uncaughtException` / `unhandledRejection`: capture, flush Sentry, then
  `exit(1)`.
- `docker-compose` has `restart: always`, so a crash produces a fresh process.
- This is deliberate: a long-running Telegram client with a corrupted
  connection state is safer restarted than kept alive.

### Sentry configuration

- `SENTRY_DSN` empty/absent → Sentry is completely disabled (local dev default).
- `SENTRY_ENVIRONMENT` tags events (`production` in the built bundle,
  `development` otherwise, overridable via env).
- `SENTRY_LOG_LEVEL` is the minimum console level forwarded to Sentry Logs
  (`debug` | `info` | `warn` | `error`, default `info`).
- Sentry Logs (`enableLogs` + `consoleLoggingIntegration`) is experimental in
  `@sentry/node` v10; verify your sentry.io plan supports Logs.
- Production build currently keeps `minify` + sourcemaps. During the trial
  period, verify that captured stack traces are readable; if not, either
  disable `minify` or add release-based sourcemap upload.

## 5. Deployment and configuration

- Runtime: Node 22 Alpine (see `Dockerfile`).
- Production artifact: single-file esbuild bundle `dist/main.mjs` + sourcemap,
  launched with `node --enable-source-maps`.
- `docker-compose`: one `bot` service, `restart: always`, `.env` passed via
  `env_file`, `./bot-data` mounted for session storage and quiz bank.
- Log collection: Docker default stdout/stderr driver; the application
  additionally forwards Sentry Logs for levels ≥ `SENTRY_LOG_LEVEL`.

### Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `API_ID`, `API_HASH`, `BOT_TOKEN` | yes | mtcute credentials |
| `LOG_PEER` | yes | numeric peer id receiving verification audit messages |
| `SENTRY_DSN` | no | Sentry DSN; empty disables Sentry |
| `SENTRY_ENVIRONMENT` | no | event environment tag |
| `SENTRY_LOG_LEVEL` | no | minimum level sent to Sentry Logs; default `info` |
| `ADMIN_IDS` | no | comma-separated user ids allowed `/reload` |
| `AD_LIST_URL` | no | ad link appended to verification messages |
| `STATE_BACKEND` | no | `memory` (default) / `sqlite` / `redis` |
| `STATE_SQLITE_PATH` | no | sqlite file path (default `bot-data/state.db`) |
| `REDIS_URL` | no | required when `STATE_BACKEND=redis` |

## 6. Sentry adoption criteria and rollback

Sentry was introduced as a **reversible trial** (sentry.io SaaS, error
monitoring plus log forwarding):

- **Success**: production exceptions are visible with readable stacks,
  environment and enough context to locate the failure; forwarded logs are
  searchable and their volume/noise is within the trial budget; no performance
  regression on the verification path; local development and Docker logs
  workflows are unchanged.
- **Rollback**: if noise/false positives exceed a usable threshold or cost
  becomes unacceptable within the trial period (2–4 weeks), remove `src/sentry.ts`
  integration points and the `@sentry/node` dependency — the `logger` API stays
  and degrades to console-only.

## 7. Known discrepancies

- `.github/copilot-instructions.md` claims env validation uses Zod; the code
  validates by hand (`src/env.ts`). This document is authoritative: no Zod.
