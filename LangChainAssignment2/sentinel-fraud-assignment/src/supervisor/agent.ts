import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";
import {
  consultBehaviourTool,
  consultContextTool,
  consultNetworkTool,
  consultDispositionTool,
} from "./tools.js";
import { alertContextMiddleware } from "./middleware.js";
import { recordUsage } from "../tokenTracker.js";
import { toolLoggingMiddleware } from "../loggingMiddleware.js";
import { log } from "../log.js";

export const SupervisorResult = z.object({
  accountId: z.string(),
  verdict: z.enum(["fraud", "legitimate", "insufficient_evidence"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  recommendedAction: z.enum(["block_card", "escalate_case", "none"]),
  actionReason: z.string(),
});
export type SupervisorResult = z.infer<typeof SupervisorResult>;

const SYSTEM_PROMPT = `You are the supervisor on a fraud triage desk. You hold four tools -- one \
per specialist -- and nothing else. You have NO database access of any kind; every fact you use \
comes from a specialist's finding, never from data you looked up yourself.

Your job is to decide who to ask, in what order, and to assemble their findings into a final \
report. You do not analyze transactions, read notes, or check devices yourself -- that is what \
the specialists are for. You weigh what they tell you.

Ordering is deliberate, not arbitrary:
1. Consult Behaviour first -- establish whether the numbers look normal for this account.
2. Consult Context -- this MUST happen before Disposition. A rules engine and raw transaction \
data cannot tell an account takeover apart from a customer who upgraded their phone; the free \
text usually can. Never skip this.
3. Consult Network -- check whether this account is linked to others.
4. Consult Disposition last, always, passing it a summary of what the other three found.

consult_disposition returns a verdict AND a recommendedAction (block_card / escalate_case / \
none). It records the verdict but does not execute the action itself -- that still requires a \
separate human-approved step outside your run. Pass its verdict, confidence, reasoning, and \
recommendedAction straight through as your own final answer; do not second-guess or override \
Disposition's call.

Do not force every case to fraud or legitimate. If the specialists disagree or the evidence is \
genuinely thin, the verdict is insufficient_evidence -- pass that through honestly rather than \
picking a side.`;

export const supervisorAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
  tools: [consultBehaviourTool, consultContextTool, consultNetworkTool, consultDispositionTool],
  systemPrompt: SYSTEM_PROMPT,
  responseFormat: toolStrategy(SupervisorResult),
  middleware: [alertContextMiddleware, toolLoggingMiddleware("Supervisor")],
});

export async function triageCase(accountId: string): Promise<SupervisorResult> {
  log("Supervisor", `starting triage for account ${accountId}`);
  const result = await supervisorAgent.invoke(
    { messages: [{ role: "user", content: `Triage account ${accountId} and determine its disposition.` }] },
    { context: { accountId } }
  );
  recordUsage(result.messages);
  const r = result.structuredResponse;
  log("Supervisor", `finished ${accountId}: verdict=${r.verdict} confidence=${r.confidence} action=${r.recommendedAction}`);
  return r;
}
