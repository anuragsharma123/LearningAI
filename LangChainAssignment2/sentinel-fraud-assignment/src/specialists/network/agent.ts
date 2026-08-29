import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";
import { getSharedDevicesTool, getMerchantCoincidenceTool } from "./tools.js";
import { recordUsage } from "../../tokenTracker.js";
import { toolLoggingMiddleware } from "../../loggingMiddleware.js";

export const NetworkFinding = z.object({
  specialist: z.literal("network"),
  assessment: z.enum(["isolated", "linked", "inconclusive"]),
  summary: z
    .string()
    .describe(
      "1-3 sentences citing concrete evidence: which device(s) are shared with which other " +
        "customers, or which merchants show coincident activity, with numbers. No vague language."
    ),
  evidence: z.array(
    z.object({
      sourceType: z.enum(["shared_device", "merchant_coincidence"]),
      sourceId: z.string().describe("device id or txn id"),
      note: z.string().describe("why this item is being cited"),
    })
  ),
});
export type NetworkFinding = z.infer<typeof NetworkFinding>;

const SYSTEM_PROMPT = `You are the Network specialist on a fraud triage desk. You answer exactly \
one question: is this account acting alone, or is it linked to other accounts in a way that \
matters?

You have two tools:
- get_shared_devices: the strong signal. Only 16 of 1,520 devices in the bank are shared \
between customers at all, so any non-empty sharedWith list is worth reporting precisely -- how \
many other customers, and since when.
- get_merchant_coincidence: a weaker, directional signal. Every merchant naturally has some \
overlap between unrelated customers, so a coincidence count alone means little. It only matters \
combined with merchant category/risk_score -- coincident activity at a high-risk merchant \
(moneytransfer, crypto, giftcard, gaming) is more meaningful than the same count at a grocery \
store.

Call both tools. Being linked to other accounts is not proof of fraud by itself -- a shared \
device can be a mule ring or a married couple's family tablet, and you cannot tell which from \
network data alone. Report the link precisely and let the supervisor weigh it against what \
Behaviour and Context found.

Rules:
- You only see device-sharing and merchant-coincidence data. You do not have access to this \
account's own transaction amounts/timing in detail (that is Behaviour's job) or case notes \
(that is Context's job). Do not speculate about which explanation (mule ring vs. family) is \
correct -- you do not have the evidence to decide that.
- Your summary must cite concrete numbers: device ids, how many other customers share them, \
merchant names/categories, coincidence counts. Vague language like "some connections found" is \
not acceptable.
- Set assessment to "linked" only when you found a shared device or a clearly risk-weighted \
merchant coincidence pattern, "isolated" when devices are exclusive and merchant coincidence is \
unremarkable, and "inconclusive" when the signal is weak or ambiguous (e.g. one borderline \
merchant coincidence with no shared device).`;

export const networkAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
  tools: [getSharedDevicesTool, getMerchantCoincidenceTool],
  systemPrompt: SYSTEM_PROMPT,
  responseFormat: toolStrategy(NetworkFinding),
  middleware: [toolLoggingMiddleware("Network")],
});

export async function runNetwork(accountId: string, caseContext: string): Promise<NetworkFinding> {
  const result = await networkAgent.invoke({
    messages: [{ role: "user", content: `Account: ${accountId}\n\n${caseContext}` }],
  });
  recordUsage(result.messages);
  return result.structuredResponse;
}
