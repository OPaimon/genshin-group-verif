# genshin-group-verif

A Telegram bot context: humans joining a group must pass a quiz challenge before they gain access.

## Language

### Verification

**Verification**:
A human check a new entrant must complete before gaining group access.
_Avoid_: Auth, captcha, onboarding

**Verification session**:
One pending challenge for one entrant in one group, from entry until it is settled.
_Avoid_: State, record, job, task

**Challenge**:
The quiz question presented to an entrant with one answer button per option and a visible deadline.
_Avoid_: Prompt, message

**Answer token**:
The opaque value carried by a challenge answer button that identifies which option was pressed.
_Avoid_: Callback data, payload

**Deadline**:
The time limit within which a challenge must be answered; an unanswered session settles as failed when it passes.
_Avoid_: TTL, timeout (use "timeout" only as the failed settlement it causes)

**Claim**:
The exclusive right to settle a verification session. At most one concurrent claimant can hold it; a claimant that fails to obtain it must not act on that session.
_Avoid_: Lock, take, checkout

**Settlement**:
The terminal outcome of a verification session: pass or fail.
_Avoid_: Completion, finalization

### Entry

**In-group join**:
Entry where an entrant joins or is added to a group directly; the challenge is presented in the group while the entrant is temporarily restricted.
_Avoid_: Member join, group entry

**Join request**:
Entry where an entrant requests to join via an invite link; the challenge is presented in a direct message while the request awaits approval.
_Avoid_: Pending member, request

**Admin bypass**:
The rule that an entrant added or approved by the group creator or an admin skips verification. A failed lookup of the actor never grants the bypass.
_Avoid_: Whitelist, exemption

### Outcomes

**Pass**:
A settlement where the entrant answered correctly: restrictions are lifted for an in-group join, or the join request is approved.
_Avoid_: Success, accept (those are fine as audit-event tags, not as outcome names)

**Soft punishment**:
A settlement where the entrant answered wrongly or let the deadline pass: they are kicked (in-group join) or their join request is declined, and they may try again later.
_Avoid_: Ban, reject, hard failure

**Cooldown**:
A waiting period after a wrong answer during which a new entry from the same entrant is settled immediately as a soft punishment without a new challenge.
_Avoid_: Rate limit, debounce

### Audit

**Audit event**:
A recordable verification lifecycle event: request started, passed, failed by deadline, or failed by error.
_Avoid_: Log line, metric
