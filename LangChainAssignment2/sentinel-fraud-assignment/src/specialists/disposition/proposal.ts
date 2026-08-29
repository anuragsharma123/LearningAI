import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, toolStrategy, tool } from "langchain";
import { z } from "zod";
import { recordDisposition } from "../../store/dispositionStore.js";
import { loadPolicyFile } from "../../policy.js";
import { recordUsage } from "../../tokenTracker.js";
import { toolLoggingMiddleware } from "../../loggingMiddleware.js";

const loadEscalationPolicyTool = tool(async () => loadPolicyFile("escalation-policy"), {
  name: "load_escalation_policy",
  description:
    "Loads fraud ops' current policy document defining exactly when to recommend block_card, " +
    "escalate_case, or no action. Call this before deciding recommendedAction rather than " +
    "guessing at the bar -- ops can change these rules without any code changing.",
  schema: z.object({}),
});

export const DispositionProposal = z.object({
  verdict: z.enum(["fraud", "legitimate", "insufficient_evidence"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string().describe("Must cite the specific evidence from Behaviour/Context/Network"),
  recommendedAction: z.enum(["block_card", "escalate_case", "none"]),
  actionReason: z.string().describe("Why this action (or no action) is proportionate. Empty string if none."),
  cardId: z.string().optional().describe("Required if recommendedAction is block_card"),
});
export type DispositionProposal = z.infer<typeof DispositionProposal>;

const SYSTEM_PROMPT = `You are the Disposition specialist on a fraud triage desk, in PROPOSAL \
mode: you decide the verdict and what action (if any) is warranted, but you do not execute \
anything yourself -- a separate, human-supervised step does that for any irreversible action \
you recommend. You do not read any data yourself; you weigh findings that Behaviour, Context, \
and Network already produced.

You have one tool: load_escalation_policy. Call it before deciding recommendedAction -- it \
defines the current, exact bar for block_card vs escalate_case vs none. Do not rely on a bar \
you recall from a previous case; ops can change it without any code changing.

Rules:
- Your reasoning must cite the specialists' specific evidence, not restate the alert.
- If the specialists disagree or evidence is genuinely inconclusive, verdict is \
insufficient_evidence -- do not force a binary call.
- Only recommend block_card or escalate_case when the loaded policy's bar for that action is \
actually met.`;

const proposalAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
  tools: [loadEscalationPolicyTool],
  systemPrompt: SYSTEM_PROMPT,
  responseFormat: toolStrategy(DispositionProposal),
  middleware: [toolLoggingMiddleware("Disposition")],
});

/**
 * Decides a verdict and recommended action, and records it -- but never
 * executes block_card/escalate_case itself, so this can never interrupt. Safe
 * to call inline from the supervisor. If an action is recommended, a separate
 * caller must run it through the interruptible agent in agent.ts.
 */
export async function proposeDisposition(accountId: string, caseContext: string): Promise<DispositionProposal> {
  const result = await proposalAgent.invoke({
    messages: [{ role: "user", content: `Account: ${accountId}\n\n${caseContext}` }],
  });
  recordUsage(result.messages);
  const proposal = result.structuredResponse;

  recordDisposition({
    accountId,
    verdict: proposal.verdict,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
  });

  return proposal;
}
