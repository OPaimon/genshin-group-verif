# Claim-first settlement of verification sessions

A verification session can be settled by concurrent actors — the answer callback and the deadline observer (plus duplicated observers after a restart). We decided that every terminal path must first claim the session: claim removes and returns the session in one atomic step, exactly one claimant wins, and only the winner may enforce the settlement. Losing a claim means the session was already settled, and the loser must do nothing.

## Considered Options

- **Status-field updates with check-then-act** — rejected: the check and the act race, so answer and timeout can both decide.
- **A separate lock that is later released** — rejected: more state, and a crash between settle and unlock recreates the race.
- **Atomic remove-then-return (claim)** — chosen: deletion is the commit; there is no second step to forget, and re-arming observers after restart is harmless because only one of them can win.

## Consequences

- Claim atomicity must live inside each state backend: event-loop synchronicity (memory), a `BEGIN IMMEDIATE` transaction (sqlite), or a Lua script (redis).
- Session updates must never resurrect a claimed session; `updateLocation` is update-if-present in every backend.
- Every future terminal path — new failure modes, admin actions, migration jobs — must claim before enforcing.
