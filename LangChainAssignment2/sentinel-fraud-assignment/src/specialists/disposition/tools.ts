import { tool } from "langchain";
import { z } from "zod";
import { recordDisposition, blockCard, escalateCase } from "../../store/dispositionStore.js";

export const recordDispositionTool = tool(
  async ({ accountId, verdict, confidence, reasoning }) =>
    JSON.stringify(recordDisposition({ accountId, verdict, confidence, reasoning })),
  {
    name: "record_disposition",
    description:
      "Records the final verdict for this account: fraud, legitimate, or " +
      "insufficient_evidence, with a confidence level and the reasoning behind it. This is " +
      "documentation only -- it does not block anything or notify anyone, and does not " +
      "require approval. Always call this exactly once, after weighing all specialist findings.",
    schema: z.object({
      accountId: z.string(),
      verdict: z.enum(["fraud", "legitimate", "insufficient_evidence"]),
      confidence: z.enum(["high", "medium", "low"]),
      reasoning: z
        .string()
        .describe("Must cite the specific evidence from Behaviour/Context/Network that decided this"),
    }),
  }
);

export const blockCardTool = tool(
  async ({ accountId, cardId, reason }) => JSON.stringify(blockCard({ accountId, cardId, reason })),
  {
    name: "block_card",
    description:
      "Blocks a card. IRREVERSIBLE -- only call this when money is plausibly still moving " +
      "(active takeover), not for a confirmed one-off or historical incident. Requires human " +
      "approval before it executes.",
    schema: z.object({
      accountId: z.string(),
      cardId: z.string(),
      reason: z.string(),
    }),
  }
);

export const escalateCaseTool = tool(
  async ({ accountId, reason }) => JSON.stringify(escalateCase({ accountId, reason })),
  {
    name: "escalate_case",
    description:
      "Escalates the case for further human investigation, without blocking the card. Use " +
      "when evidence is serious but not conclusive enough to act on immediately, or when " +
      "human judgment is needed on a genuinely ambiguous case. Requires human approval before " +
      "it executes.",
    schema: z.object({
      accountId: z.string(),
      reason: z.string(),
    }),
  }
);
