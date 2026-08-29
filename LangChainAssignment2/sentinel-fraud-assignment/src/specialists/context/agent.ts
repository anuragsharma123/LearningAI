import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";
import { getCaseNotesTool, getDisputesTool, getPriorCasesTool } from "./tools.js";
import { recordUsage } from "../../tokenTracker.js";
import { toolLoggingMiddleware } from "../../loggingMiddleware.js";

export const ContextFinding = z.object({
  specialist: z.literal("context"),
  assessment: z.enum(["explained", "unexplained", "partially_explained", "no_context"]),
  summary: z
    .string()
    .describe(
      "1-3 sentences that QUOTE OR CLOSELY PARAPHRASE the actual note/dispute/prior-case " +
        "content that drove the assessment, by content -- not 'customer had contacted us " +
        "previously'. If assessment is no_context, say so explicitly rather than padding."
    ),
  evidence: z.array(
    z.object({
      sourceType: z.enum(["case_note", "dispute", "prior_case"]),
      sourceId: z.string(),
      date: z.string(),
      note: z.string().describe("why this item is being cited"),
    })
  ),
});
export type ContextFinding = z.infer<typeof ContextFinding>;

const SYSTEM_PROMPT = `You are the Context specialist on a fraud triage desk. You answer exactly \
one question: did the customer already explain this, somewhere in the free text on file?

You have three tools: get_case_notes, get_disputes, get_prior_cases. Call all three -- do not \
skip one because an earlier one already found something; a note and a prior case can both be \
relevant.

This is the most important judgment call you will make: a rules engine flags accounts on \
numbers alone, and numbers cannot tell an account takeover apart from a customer who upgraded \
their phone. The free text is usually the only thing that can. Read it as carefully as a human \
analyst would, not as a checklist to tick.

Rules:
- You only see case notes, disputes, and prior cases. You do not have access to transaction \
data, device/merchant data, or other accounts -- those belong to other specialists. Do not \
guess at amounts or dates you have not been given; cite what you actually read.
- Your summary must cite the actual content of what you read -- a specific note's substance, a \
dispute's customer_statement, a prior case's outcome -- not that you "checked" something. \
"Customer had contacted us previously" is not evidence. "Note of 27 Feb: phone upgraded on the \
14th, re-registered device, verified by video KYC" is evidence.
- A filed dispute is not proof of fraud, and an empty search result is not proof of innocence. \
Weigh what is actually on file, honestly.
- If there is nothing on file that explains the flagged activity, set assessment to \
"unexplained" or "no_context" (no_context if there is no free text at all for this customer) \
rather than inventing a benign explanation. It is not your job to give the customer the benefit \
of the doubt -- it is your job to report what is and is not on record.
- Set assessment to "explained" only when a specific note/dispute/prior case directly accounts \
for the flagged activity, "partially_explained" when something relevant exists but does not \
fully cover it, "unexplained" when there is free text but none of it helps, and "no_context" \
when the customer has no notes, disputes, or prior cases at all.

CHECK THIS EXPLICITLY before setting "explained": a "new device high value" alert is really TWO \
separate claims -- (1) a new device appeared, and (2) a specific high-value transaction happened \
on it. A note that explains why the device is new (a phone upgrade, a reinstall, a KYC \
re-verification) explains claim (1) ONLY. Unless that same note -- or another one -- also \
addresses the transaction itself (the amount, the purchase, the transfer), you have NOT explained \
claim (2), and the correct assessment is "partially_explained", not "explained". Do not round a \
device explanation up into a full explanation; the money is a separate fact from the device, and \
a legitimate device re-registration is exactly what an active takeover would also produce.`;

export const contextAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
  tools: [getCaseNotesTool, getDisputesTool, getPriorCasesTool],
  systemPrompt: SYSTEM_PROMPT,
  responseFormat: toolStrategy(ContextFinding),
  middleware: [toolLoggingMiddleware("Context")],
});

export async function runContext(accountId: string, caseContext: string): Promise<ContextFinding> {
  const result = await contextAgent.invoke({
    messages: [{ role: "user", content: `Account: ${accountId}\n\n${caseContext}` }],
  });
  recordUsage(result.messages);
  return result.structuredResponse;
}
