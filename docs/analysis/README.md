# Architecture Analysis — genshin-group-verif

An LLM-produced, code-verified analysis of the `genshin-group-verif` repository.
Every factual claim is pinned to commit `83d9392` and, wherever a precise claim
matters, to a `file:line` reference.

## Baseline and verification summary

| Check | Result |
| --- | --- |
| Commit analyzed | `83d9392` (`analysis/llm-project-analysis`) |
| `pnpm test` | **61/61 pass** — Flow suite (17 tests) + TS suites (44 tests) |
| `pnpm lint` | Pass |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm build` | **Fails** — `ENOENT bot-data/quizzes.json` at `build.mjs:71` (quizzes.json is git-ignored and not committed) |
| Node.js used for the test runs | `v25.9.0` |
| Live Redis available | No — Redis conformance ran against `ioredis-mock`, which executes the same Lua claim script |

## Document index

| Doc | Answers |
| --- | --- |
| [01-module-map.md](01-module-map.md) | What lives where, how modules depend on each other, where the code has been changing. |
| [02-behavior-and-invariants.md](02-behavior-and-invariants.md) | What the verification state machine does, branch by branch, and which invariants hold or fail. |
| [03-seams-and-interfaces.md](03-seams-and-interfaces.md) | The four effect-signature seams (AppBridge, InteractionSig, StateSig, QuizSourceSig) and their real contracts. |
| [04-state-backends.md](04-state-backends.md) | memory / sqlite / redis consistency, claim atomicity, and the divergences outside the conformance suite. |
| [05-errors-logging-observability.md](05-errors-logging-observability.md) | Error handling strategy and the three logging surfaces: console, Sentry, LOG_PEER. |
| [06-deployment.md](06-deployment.md) | Build, Docker, env configuration, and the verified deployment-breaking gap. |
| [07-testing.md](07-testing.md) | What the 61 tests actually pin down and where the weak spots are. |
| [08-risk-register.md](08-risk-register.md) | Structured risk list with evidence, trigger scenarios, and recommendations. |
| [09-deepening-opportunities.md](09-deepening-opportunities.md) | Deepening opportunities with interface / seam / depth / leverage fields. |

## Reading order

1. `01-module-map.md` — get the lay of the land.
2. `02-behavior-and-invariants.md` — the domain core; read together with [CONTEXT.md](../../CONTEXT.md).
3. `03-seams-and-interfaces.md` — the contracts the core relies on.
4. `04-state-backends.md` — the deepest correctness surface.
5. `05` → `06` → `07` — cross-cutting concerns and evidence.
6. `08-risk-register.md` — consolidated conclusions.
7. `09-deepening-opportunities.md` — where the architecture could earn more leverage.

## Conventions

- **`file:line`** refers to the file at commit `83d9392`.
- **Domain vocabulary** comes from [CONTEXT.md](../../CONTEXT.md); use those terms,
  not synonyms.
- **Architecture vocabulary** (`module`, `interface`, `seam`, `adapter`, `depth`,
  `leverage`, `locality`) follows the codebase-design glossary used by this analysis.
- **ADR references** point to [docs/adr](../adr/).
- **"Not run"** means the check was not executable in this environment; it is stated
  explicitly rather than assumed.
