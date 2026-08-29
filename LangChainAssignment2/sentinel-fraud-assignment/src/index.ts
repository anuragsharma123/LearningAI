import { createInterface } from "node:readline/promises";
import { triageCase, type SupervisorResult } from "./supervisor/agent.js";
import { startSweep, getSweepStatus, getSweepResults } from "./sweep/tools.js";
import { runDisposition, resumeDisposition } from "./specialists/disposition/agent.js";
import type { HITLRequest, Interrupt } from "langchain";

function usage(): never {
  console.error("Usage:");
  console.error("  npm run dev -- <accountId>            triage a single account");
  console.error("  npm run dev -- --sweep [limit]         start a queue sweep, returns a job id immediately");
  console.error("  npm run dev -- --status <jobId>        check a sweep's progress");
  console.error("  npm run dev -- --collect <jobId>       get a sweep's results so far");
  process.exit(1);
}

/**
 * Asks a human to approve/reject the action Disposition recommended, then
 * actually executes that decision through the interruptible agent. The
 * caseContext directs it to execute the already-made decision rather than
 * re-deriving its own verdict from scratch.
 */
async function requestApproval(result: SupervisorResult): Promise<void> {
  const directive =
    `Disposition has already determined this case, from the supervisor's findings:\n` +
    `verdict=${result.verdict}, confidence=${result.confidence}, recommendedAction=${result.recommendedAction}\n` +
    `Reasoning: ${result.reasoning}\n` +
    `Action reason: ${result.actionReason}\n\n` +
    `Record this disposition exactly as stated, then call ${result.recommendedAction} with this ` +
    `reasoning as the reason.`;

  const threadId = `disposition-${result.accountId}-${Date.now()}`;
  const paused = await runDisposition(threadId, result.accountId, directive);

  if (!paused.__interrupt__) {
    console.log("\nDisposition ran without requesting an irreversible action after all:");
    console.log(JSON.stringify(paused.structuredResponse, null, 2));
    return;
  }

  const interrupt = paused.__interrupt__[0] as Interrupt<HITLRequest>;
  const request = interrupt.value.actionRequests[0];

  console.log(`\n--- Approval required ---\n${request.description}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Approve? [y/N]: ")).trim().toLowerCase();
  rl.close();

  const approved = answer === "y" || answer === "yes";
  const resumed = await resumeDisposition(
    threadId,
    approved
      ? { decisions: [{ type: "approve" }] }
      : { decisions: [{ type: "reject", message: "Rejected by operator via CLI prompt." }] }
  );

  console.log(`\n${approved ? "Approved" : "Rejected"}. Final disposition:`);
  console.log(JSON.stringify(resumed.structuredResponse, null, 2));
}

const [arg1, arg2] = process.argv.slice(2);

if (!arg1) usage();

if (arg1 === "--sweep") {
  const limit = arg2 ? Number(arg2) : undefined;
  const { jobId, total } = startSweep(limit);
  console.log(JSON.stringify({ jobId, total, status: "running" }, null, 2));
  console.log(`\nCheck progress with: npm run dev -- --status ${jobId}`);
} else if (arg1 === "--status") {
  if (!arg2) usage();
  console.log(JSON.stringify(getSweepStatus(arg2), null, 2));
} else if (arg1 === "--collect") {
  if (!arg2) usage();
  console.log(JSON.stringify(getSweepResults(arg2), null, 2));
} else {
  const result = await triageCase(arg1);
  console.log(JSON.stringify(result, null, 2));
  if (result.recommendedAction !== "none") {
    await requestApproval(result);
  }
}

// Our work is done -- exit immediately rather than risk a stray background
// SDK retry/timer firing later and crashing the process after the fact.
process.exit(0);
