# Sentinel

A multi-agent fraud triage system built on LangChain.js / LangGraph and Claude
(Sonnet 5). Reads the alert queue in `data/sentinel.db` and produces a
defensible verdict for each flagged account, citing the specific evidence
behind it.

The original assignment brief, rubric, and data schema live in
[`ASSIGNMENT.md`](ASSIGNMENT.md), [`RUBRIC.md`](RUBRIC.md), and
[`SCHEMA.md`](SCHEMA.md) -- this file is just how to run the code.

## Setup

```bash
npm install
```

Put an Anthropic API key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Running a single case

```bash
npm run dev -- <accountId>
```

Example:

```bash
npm run dev -- A00985
```

Loads that account's alert(s) from the database, consults the four
specialists (Behaviour → Context → Network → Disposition, in that order),
and prints the final verdict as JSON: `verdict`, `confidence`, `reasoning`,
and `recommendedAction` (`block_card` / `escalate_case` / `none`).

If `recommendedAction` is not `none`, it has been **recorded but not
executed** -- see [Approving an action](#approving-an-action-block_card--escalate_case)
below.

## Running the full queue sweep

Starting a sweep returns a job id immediately (well under a second of actual
work; the printed time includes Node/tsx startup) and processes the queue in
a detached background process, six accounts at a time:

```bash
npm run dev -- --sweep          # all 276 accounts
npm run dev -- --sweep 10       # first 10 only, for a quick test
```

Check progress at any time, including from a separate terminal while it's
still running:

```bash
npm run dev -- --status <jobId>
```

Once `status` is `"completed"`, get the results:

```bash
npm run dev -- --collect <jobId>
```

Job state lives in `output/jobs/<jobId>.json` -- you can also just read that
file directly.

## Approving an action (`block_card` / `escalate_case`)

Recommending an irreversible action and *executing* it are deliberately
separate. The supervisor / sweep only ever recommends and records a
verdict -- it can never block a card or escalate a case itself, so a sweep of
276 accounts never needs a human standing by.

To actually carry out a recommended action, run it through the interruptible
Disposition agent directly (`src/specialists/disposition/agent.ts`), which
pauses for approval before doing anything irreversible:

```ts
import { runDisposition, resumeDisposition } from "./src/specialists/disposition/agent.js";

const threadId = `disposition-${accountId}`;
const paused = await runDisposition(threadId, accountId, caseContext);
// paused.__interrupt__[0].value describes the pending action

// to approve:
await resumeDisposition(threadId, { decisions: [{ type: "approve" }] });

// to reject:
await resumeDisposition(threadId, {
  decisions: [{ type: "reject", message: "why not" }],
});
```

Executed actions land in `output/actions.json`; every verdict (approved,
rejected, or no action needed) lands in `output/dispositions.json`.

## Editing policy without touching code

`policy/behaviour-anomaly-thresholds.md` and `policy/escalation-policy.md`
are plain markdown, loaded on demand by Behaviour and Disposition
respectively. Edit either file and the next run picks up the change --
no code changes, no redeploy.

## Project layout

```
src/
  db.ts                       read-only connection to data/sentinel.db
  policy.ts                   generic policy-file loader
  tokenTracker.ts             process-wide token usage accumulator
  index.ts                    CLI entry point
  specialists/
    behaviour/                 reads transactions only
    context/                   reads case notes, disputes, prior cases
    network/                   reads devices, merchants (cross-account)
    disposition/
      proposal.ts               verdict + recommended action, never interrupts
      agent.ts                  executes block_card/escalate_case, human-gated
  supervisor/
    agent.ts                   pure router: 4 tools, zero DB access
    middleware.ts               loads alert context before the supervisor reasons
    tools.ts                    wraps each specialist so only its final finding returns
  sweep/                       async queue sweep (job store, worker, queue loader)
  store/                       disposition/action output store (never touches sentinel.db)
policy/                       editable policy documents
output/                       everything this system writes (gitignored except this note)
```

## Rules this system follows

- `data/sentinel.db` is opened read-only and never written to.
- The supervisor holds zero database tools; every fact it uses comes from a
  specialist's finding.
- Each specialist only receives its own domain's tools.
- `block_card` and `escalate_case` always require human approval before they
  execute -- see above.
