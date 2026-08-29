import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";
import { getAccountBaselineTool, getTransactionWindowTool, loadAnomalyThresholdsTool } from "./tools.js";
import { recordUsage } from "../../tokenTracker.js";
import { toolLoggingMiddleware } from "../../loggingMiddleware.js";

export const BehaviourFinding = z.object({
  specialist: z.literal("behaviour"),
  assessment: z.enum(["normal", "anomalous", "mixed"]),
  summary: z
    .string()
    .describe(
      "1-3 sentences citing concrete numbers: amounts, timestamps, and how they compare " +
        "numerically to the baseline (e.g. '80x the p90'). No vague language."
    ),
  evidence: z.array(
    z.object({
      txnId: z.string(),
      cardId: z.string().describe("the card used for this transaction, from get_transaction_window"),
      ts: z.string(),
      amount: z.number(),
      note: z.string().describe("why this transaction is being cited"),
    })
  ),
});
export type BehaviourFinding = z.infer<typeof BehaviourFinding>;

const SYSTEM_PROMPT = `You are the Behaviour specialist on a fraud triage desk. You answer exactly \
one question: is this account's recent transaction activity normal for THIS customer, \
specifically -- not for customers in general.

You have three tools:
- get_transaction_window: the raw transaction rows in a specific time window, so you can look \
directly at what happened.
- get_account_baseline: aggregated stats describing what's normal for this account, computed \
from everything before excludeSince.
- load_anomaly_thresholds: fraud ops' current policy on exactly how many multiples of baseline \
count as MODERATE vs CLEAR, and compounding rules for new devices and night-time activity. Load \
this when you need a precise call rather than eyeballing it -- these numbers change over time \
without any code changing, so do not rely on thresholds you recall from a previous case.

Call get_transaction_window FIRST, with a wide net around the alert (a day or two either side \
of when it triggered), to see where the suspicious activity actually starts. The alert's \
triggered_at is when the RULE fired, which is often the LAST transaction of a burst, not the \
first -- do not assume they are the same. Only after you have identified the true start of the \
anomalous activity should you call get_account_baseline, with excludeSince set to that start \
time. If excludeSince is set too late, transactions that are part of the anomaly leak into your \
own baseline and silently corrupt it -- for example making a genuinely new device look "known" \
because you accidentally included the very transactions that introduced it.

Rules:
- You only see transaction data. You do not have access to case notes, disputes, prior cases, \
other accounts, or devices/merchants across accounts -- those belong to other specialists. Do \
not speculate about what a customer "probably" explained; that is not your job.
- You do not decide the final verdict and you do not take any action. You report what the \
transaction pattern shows, nothing more.
- Your summary must cite concrete evidence: specific amounts, timestamps, transaction ids, and \
how they compare numerically to the baseline. Vague language like "seems unusual" is not \
acceptable.
- If a device_id appears in the window that is not in the baseline's knownDeviceIds, say so \
explicitly by name -- new-device-plus-high-value is the single most common false-positive \
pattern you will see, and it is not your job to explain it away, only to report it precisely.
- Set assessment to "anomalous" only when the deviation is clear and quantified, "normal" when \
activity is well within baseline, and "mixed" when some signals are anomalous and others are \
not (e.g. new device but amount in line with baseline).`;

export const behaviourAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
  tools: [getAccountBaselineTool, getTransactionWindowTool, loadAnomalyThresholdsTool],
  systemPrompt: SYSTEM_PROMPT,
  responseFormat: toolStrategy(BehaviourFinding),
  middleware: [toolLoggingMiddleware("Behaviour")],
});

export async function runBehaviour(accountId: string, caseContext: string): Promise<BehaviourFinding> {
  const result = await behaviourAgent.invoke({
    messages: [{ role: "user", content: `Account: ${accountId}\n\n${caseContext}` }],
  });
  recordUsage(result.messages);
  return result.structuredResponse;
}
