import { tool } from "langchain";
import { z } from "zod";
import { getCaseNotes, getDisputes, getPriorCases } from "./queries.js";

const accountIdSchema = z.object({
  accountId: z.string().describe("The account id, e.g. A00985"),
});

export const getCaseNotesTool = tool(
  async ({ accountId }) => JSON.stringify(getCaseNotes(accountId)),
  {
    name: "get_case_notes",
    description:
      "Returns the full text of every case note on file for this account's customer, oldest " +
      "first. This is written by staff after speaking to the customer -- travel notices, " +
      "device changes, explanations of unusual spending, reports that a transaction wasn't " +
      "made. Read the note text itself; do not just report that notes exist.",
    schema: accountIdSchema,
  }
);

export const getDisputesTool = tool(
  async ({ accountId }) => JSON.stringify(getDisputes(accountId)),
  {
    name: "get_disputes",
    description:
      "Returns disputes filed against this account's transactions, with the customer's own " +
      "statement about the transaction they're challenging. Note: a filed dispute is not proof " +
      "of fraud -- some are chargebacks over undelivered goods, some are a family member using " +
      "the card. Read the reason_code and status alongside the statement.",
    schema: accountIdSchema,
  }
);

export const getPriorCasesTool = tool(
  async ({ accountId }) => JSON.stringify(getPriorCases(accountId)),
  {
    name: "get_prior_cases",
    description:
      "Returns prior fraud investigations opened on this account's customer, most recent " +
      "first, with outcome (confirmed_fraud / false_positive / insufficient_evidence) and a " +
      "summary. A customer with three prior false positives is a different read than one with " +
      "a confirmed compromise last year -- weigh outcome and recency, not just count.",
    schema: accountIdSchema,
  }
);
