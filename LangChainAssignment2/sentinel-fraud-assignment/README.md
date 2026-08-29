# Sentinel

A multi-agent fraud triage system built on LangChain.js / LangGraph and Claude
(Haiku 4.5). Reads the alert queue in `data/sentinel.db` and produces a
defensible verdict for each flagged account, citing the specific evidence
behind it.

The original assignment brief, rubric, and data schema live in
[`ASSIGNMENT.md`](ASSIGNMENT.md), [`RUBRIC.md`](RUBRIC.md), and
[`SCHEMA.md`](SCHEMA.md) -- this file is just how to run the code.

## Getting the code

This project lives on its own branch inside a larger personal monorepo --
cloning pulls in unrelated folders too, so check out the branch and `cd`
into the actual project path below before doing anything else.

```bash
git clone git@github.com:anuragsharma123/LearningAI.git
cd LearningAI
git checkout sentinel-fraud-assignment
cd LangChainAssignment2/sentinel-fraud-assignment
```

Everything from here on (`npm install`, `npm run dev`, etc.) is run from
that final directory.

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

If `recommendedAction` is not `none`, the CLI immediately prompts you at the
terminal -- it shows the exact pending action and Disposition's reason, then
asks `Approve? [y/N]`. Only on `y` does it actually execute the action
(through the interruptible Disposition agent); anything else rejects it.
Nothing irreversible ever happens without that prompt. See
[Approving an action](#approving-an-action-block_card--escalate_case) below
for what's happening under the hood, and how to do the same thing
programmatically (e.g. for the sweep, where nothing prompts automatically).

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

**Single-case runs (`npm run dev -- <accountId>`) handle this for you** --
see above. What follows is what that prompt is doing under the hood, useful
if you're approving a recommendation that came out of a sweep instead, where
nothing prompts automatically since no human is watching a sweep run.

**The mechanism, independent of language:** Disposition is a LangGraph agent.
When it's about to call a tool that's marked as needing approval, LangGraph
*pauses the entire agent mid-run* -- not a blocking prompt inside one
function call, but the whole graph's execution state is checkpointed and
control returns to whoever is running it, carrying a description of exactly
what the agent wants to do and why. Nothing happens until that run is
resumed with an explicit decision: approve, or reject with a reason. If you
know LangGraph's Python SDK, this is the exact same `interrupt()` /
`Command(resume=...)` pattern (`langgraph.types.interrupt`) -- the JS API
here is a direct mirror of it, just with `await` instead of Python's
generator-based checkpointing. Two things enforce this:

1. `humanInTheLoopMiddleware` is configured (in `disposition/agent.ts`) to
   intercept exactly two tools -- `block_card` and `escalate_case` -- and
   nothing else. Every other tool call goes through untouched.
2. A checkpointer (`MemorySaver`) persists the paused state under a `threadId`,
   so "resume" means "continue this exact run," not "start a new one."

Concretely, one run through this looks like:

- **Start a run.** Call the agent with an account id and case context. If it
  decides an irreversible action is warranted, it stops there instead of
  finishing -- the return value carries a description of the pending action
  (e.g. *"Escalate case for account A00513? Reason: ..."*) instead of a
  final verdict.
- **Show that description to a human**, however your integration does that
  -- a CLI prompt (this is what `npm run dev -- <accountId>` does for you
  automatically), a Slack message, a review queue -- LangGraph doesn't care.
- **Resume the same run with a decision.** Approve it, and the paused tool
  call actually executes (the card really gets blocked, the case really
  gets escalated) before the run produces its final verdict. Reject it with
  a reason, and the run finishes without ever calling that tool -- the
  rejection reason flows back into the agent's own final reasoning instead.

The actual TypeScript, in `src/specialists/disposition/agent.ts` and driven
by `src/index.ts`, is two functions built exactly on that shape:
`runDisposition(threadId, accountId, caseContext)` starts (or restarts) a
run and returns either a final result or a paused `__interrupt__` payload;
`resumeDisposition(threadId, decision)` continues a paused run with
`{ decisions: [{ type: "approve" }] }` or
`{ decisions: [{ type: "reject", message: "..." }] }`.

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
