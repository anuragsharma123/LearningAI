import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, toolStrategy, humanInTheLoopMiddleware, type HITLResponse } from "langchain";
import { Command, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { recordDispositionTool, blockCardTool, escalateCaseTool } from "./tools.js";
import { toolLoggingMiddleware } from "../../loggingMiddleware.js";

export const DispositionResult = z.object({
  specialist: z.literal("disposition"),
  verdict: z.enum(["fraud", "legitimate", "insufficient_evidence"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  actionsTaken: z.array(
    z.object({
      action: z.enum(["block_card", "escalate_case"]),
      outcome: z.enum(["approved", "rejected"]),
    })
  ),
});
export type DispositionResult = z.infer<typeof DispositionResult>;

const SYSTEM_PROMPT = `You are the Disposition specialist on a fraud triage desk. You do not \
read any data yourself -- you receive findings that Behaviour, Context, and Network already \
produced, and your job is to weigh them into a final decision and, if warranted, act on it.

You have three tools:
- record_disposition: always call this exactly once, with your final verdict, confidence, and \
reasoning. This just documents the decision and requires no approval.
- block_card: IRREVERSIBLE. Only call this when money is plausibly still moving -- an active \
takeover, not a confirmed one-off or something that already happened and stopped. Requires \
human approval; if rejected, do not retry it, record the disposition accordingly instead.
- escalate_case: IRREVERSIBLE in the sense that it commits investigator time. Use for serious \
but inconclusive cases where a human needs to look closer. Also requires approval.

Severity must be proportionate to what is actually still at risk -- a confirmed historical \
incident with no ongoing exposure does not get the same response as an account actively being \
drained. Do not block a card just because the verdict is "fraud" if the fraudulent activity is \
already over and there is nothing left to stop.

Call your tools ONE AT A TIME, never in parallel in the same turn. Specifically: call \
record_disposition by itself and wait for its result before calling block_card or \
escalate_case, if either is warranted, as a separate, subsequent tool call. Do not call \
record_disposition together with block_card or escalate_case in the same turn.

Rules:
- Weigh what Behaviour, Context, and Network actually found -- your reasoning must cite their \
specific evidence (e.g. "Context found a matching KYC-verified note" or "Network found no \
shared devices"), not restate the alert.
- If the specialists disagree or the evidence is genuinely inconclusive, verdict is \
insufficient_evidence -- do not force a binary call, and do not escalate every uncertain case \
just to be safe; escalate only when the stakes justify committing a human's time.
- Always call record_disposition. Only call block_card or escalate_case when the case actually \
warrants an irreversible action -- most legitimate cases need neither.`;

const hitl = humanInTheLoopMiddleware({
  interruptOn: {
    block_card: {
      allowedDecisions: ["approve", "reject"],
      description: (toolCall) =>
        `Block card ${toolCall.args.cardId} on account ${toolCall.args.accountId}?\nReason: ${toolCall.args.reason}`,
    },
    escalate_case: {
      allowedDecisions: ["approve", "reject"],
      description: (toolCall) =>
        `Escalate case for account ${toolCall.args.accountId}?\nReason: ${toolCall.args.reason}`,
    },
  },
});

const checkpointer = new MemorySaver();

export const dispositionAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
  tools: [recordDispositionTool, blockCardTool, escalateCaseTool],
  systemPrompt: SYSTEM_PROMPT,
  responseFormat: toolStrategy(DispositionResult),
  middleware: [hitl, toolLoggingMiddleware("Disposition-act")],
  checkpointer,
});

/**
 * Starts a disposition run. If the agent calls block_card or escalate_case, this
 * returns with `__interrupt__` set instead of a structuredResponse -- call
 * resumeDisposition with the same threadId to continue.
 */
export async function runDisposition(threadId: string, accountId: string, caseContext: string) {
  return dispositionAgent.invoke(
    { messages: [{ role: "user", content: `Account: ${accountId}\n\n${caseContext}` }] },
    { configurable: { thread_id: threadId } }
  );
}

/** Resumes a paused disposition run with a human decision (approve or reject). */
export async function resumeDisposition(threadId: string, response: HITLResponse) {
  return dispositionAgent.invoke(new Command({ resume: response }), {
    configurable: { thread_id: threadId },
  });
}
