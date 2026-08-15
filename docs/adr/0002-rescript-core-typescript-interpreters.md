# ReScript state machine with TypeScript effect interpreters

We decided that the verification logic is a pure ReScript state machine (`Flow.Make`) and every side effect lives in TypeScript behind three interfaces — `InteractionSig`, `StateSig`, `QuizSourceSig` — bridged by `AppBridge`. The state machine can be tested with a mock interpreter and no Telegram client; TypeScript keeps the frequently-changing mtcute integration where its own types live.

## Considered Options

- **All TypeScript** — rejected: business rules would mix with transport code, and the testability the state machine gets from typed effect signatures would be weaker.
- **ReScript bindings for mtcute** — rejected: mtcute is a large, actively evolving TypeScript library; bindings would be constant maintenance.
- **Two languages behind a bridge** — chosen: the cost is a name-string bridge and duplicated domain types via genType, accepted in exchange for a pure, testable core.

## Consequences

- Domain types in `Domain.res` are shared with TypeScript through generated `Domain.gen.tsx`.
- TypeScript interpreter exports are an implicit part of the bridge interface; renames must update `AppBridge.res` externals.
- Flow tests run against the ReScript `MockInterpreter`; the real TypeScript interpreters need their own tests.
