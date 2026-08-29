import { tool } from "langchain";
import { z } from "zod";
import { runBehaviour } from "../specialists/behaviour/agent.js";
import { runContext } from "../specialists/context/agent.js";
import { runNetwork } from "../specialists/network/agent.js";
import { proposeDisposition } from "../specialists/disposition/proposal.js";

const consultSchema = z.object({
  accountId: z.string().describe("The account id, e.g. A00985"),
  caseContext: z
    .string()
    .describe("What this specialist needs to know about the case: the alert(s) that fired, and why"),
});

export const consultBehaviourTool = tool(
  async ({ accountId, caseContext }) => JSON.stringify(await runBehaviour(accountId, caseContext)),
  {
    name: "consult_behaviour",
    description:
      "Ask the Behaviour specialist whether this account's recent transaction activity is " +
      "normal for this customer specifically. Returns only its final finding -- not its " +
      "intermediate tool calls.",
    schema: consultSchema,
  }
);

export const consultContextTool = tool(
  async ({ accountId, caseContext }) => JSON.stringify(await runContext(accountId, caseContext)),
  {
    name: "consult_context",
    description:
      "Ask the Context specialist whether the customer already explained the flagged activity, " +
      "in case notes, disputes, or prior cases. Returns only its final finding. Consult this " +
      "before deciding a disposition -- numbers alone cannot separate a takeover from a " +
      "customer who upgraded their phone; the free text is usually what can.",
    schema: consultSchema,
  }
);

export const consultNetworkTool = tool(
  async ({ accountId, caseContext }) => JSON.stringify(await runNetwork(accountId, caseContext)),
  {
    name: "consult_network",
    description:
      "Ask the Network specialist whether this account is linked to others via shared devices " +
      "or coincident activity at high-risk merchants. Returns only its final finding.",
    schema: consultSchema,
  }
);

export const consultDispositionTool = tool(
  async ({ accountId, caseContext }) => JSON.stringify(await proposeDisposition(accountId, caseContext)),
  {
    name: "consult_disposition",
    description:
      "Ask the Disposition specialist to weigh all findings you've gathered so far into a final " +
      "verdict and a recommended action (block_card, escalate_case, or none). ONLY call this " +
      "after you have consulted Context -- disposing of a case before reading the context is not " +
      "allowed. This records the verdict but does NOT execute any action itself -- a recommended " +
      "action still requires separate human approval before it happens, outside this call.",
    schema: z.object({
      accountId: z.string().describe("The account id, e.g. A00985"),
      caseContext: z
        .string()
        .describe(
          "A summary of what Behaviour, Context, and Network each found -- their assessments " +
            "and the specific evidence behind them, not just the raw alert."
        ),
    }),
  }
);
