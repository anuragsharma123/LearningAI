# Escalation Policy

Editable by fraud ops. Disposition loads this on demand when deciding what action,
if any, to recommend -- it is not baked into every prompt.

## When to recommend block_card

Recommend `block_card` only when ALL of the following hold:

- Verdict is `fraud` with `high` confidence.
- There is concrete evidence the exposure is current, not historical -- the
  flagged activity happened within the last 48 hours and nothing in Context or
  Network suggests it has already stopped (e.g. a customer report, a closed
  prior case, or a burst that clearly concluded).
- The account/card is not already reported closed or blocked.

A confirmed one-off incident with no ongoing exposure does NOT meet this bar,
even at high confidence -- there is nothing left to stop by blocking.

## When to recommend escalate_case instead

Recommend `escalate_case` when the evidence is serious enough to warrant human
investigator time, but block_card is not (yet) warranted:

- Confidence is `medium`, not `high`.
- The suspicious activity appears to have already concluded.
- The case involves a broader linked-account or network pattern (shared
  devices, coordinated merchant activity) that needs investigation beyond what
  any single specialist can resolve.
- Verdict is `insufficient_evidence` but the stakes are high enough that a
  human should look rather than the case sitting unresolved indefinitely.

## When to recommend none

- Verdict is `legitimate`.
- Verdict is `insufficient_evidence` and there is no indication of ongoing
  risk -- most thin cases should simply be recorded, not escalated as a
  reflex. Escalation is for cases where the stakes justify committing a
  human's time, not a hedge against every uncertain call.
