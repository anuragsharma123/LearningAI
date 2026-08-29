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

**What this proves:** the system can never block a card or escalate a case
on its own. Every irreversible action stops and waits for a yes/no from a
human, and the run finishes correctly either way -- approved actions really
execute, rejected ones don't, and rejecting isn't a dead end (the agent
produces a normal final result either way, not an error).

Single-case runs (`npm run dev -- <accountId>`) ask you automatically: if
the verdict recommends an action, you'll see `Approve? [y/N]` right there.

Sweeps don't ask -- 276 accounts can't wait on a human -- so a recommendation
from a sweep is approved separately, after the fact:

```ts
const paused = await runDisposition(threadId, accountId, caseContext);
// paused describes the pending action -- show it to a human

await resumeDisposition(threadId, { decisions: [{ type: "approve" }] });
// or: { decisions: [{ type: "reject", message: "why not" }] }
```

Approved actions land in `output/actions.json`. Every verdict, either way,
lands in `output/dispositions.json`.

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
