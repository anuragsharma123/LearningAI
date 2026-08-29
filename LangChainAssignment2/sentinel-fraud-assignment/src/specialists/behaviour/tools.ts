import { tool } from "langchain";
import { z } from "zod";
import { getAccountBaseline, getTransactionWindow } from "./queries.js";
import { loadPolicyFile } from "../../policy.js";

export const getAccountBaselineTool = tool(
  async ({ accountId, excludeSince }) => {
    return JSON.stringify(getAccountBaseline(accountId, excludeSince));
  },
  {
    name: "get_account_baseline",
    description:
      "Returns aggregated statistics (not raw rows) describing this account's normal " +
      "transaction pattern: typical amount (mean/median/p90), channel mix, country mix, " +
      "known device ids, decline rate, and fraction of transactions at night (00:00-05:59). " +
      "Pass excludeSince (an ISO timestamp) to exclude the flagged window itself from the " +
      "baseline, so the anomaly doesn't pollute what counts as 'normal'. Call " +
      "get_transaction_window first to find where the anomaly actually starts -- do not assume " +
      "it starts at the alert's triggered_at, which is often the LAST transaction of a burst.",
    schema: z.object({
      accountId: z.string().describe("The account id, e.g. A00985"),
      excludeSince: z
        .string()
        .optional()
        .describe("ISO timestamp; transactions at or after this time are excluded from the baseline"),
    }),
  }
);

export const getTransactionWindowTool = tool(
  async ({ accountId, fromTs, toTs }) => {
    return JSON.stringify(getTransactionWindow(accountId, fromTs, toTs));
  },
  {
    name: "get_transaction_window",
    description:
      "Returns the raw transaction rows (txn id, timestamp, amount, channel, ip country, " +
      "device id, auth result) for this account between fromTs and toTs, inclusive. Call this " +
      "FIRST, with a wide window around the alert, to see exactly where the suspicious activity " +
      "starts -- then call get_account_baseline with excludeSince set to that start time.",
    schema: z.object({
      accountId: z.string().describe("The account id, e.g. A00985"),
      fromTs: z.string().describe("ISO timestamp, inclusive lower bound"),
      toTs: z.string().describe("ISO timestamp, inclusive upper bound"),
    }),
  }
);

export const loadAnomalyThresholdsTool = tool(async () => loadPolicyFile("behaviour-anomaly-thresholds"), {
  name: "load_anomaly_thresholds",
  description:
    "Loads fraud ops' current policy document defining exactly how anomalous a transaction " +
    "or burst must be to count as MODERATE vs CLEAR, and the compounding rules for new " +
    "devices and night-time activity. Call this when you need a precise threshold rather than " +
    "guessing -- ops can change these numbers without any code changing.",
  schema: z.object({}),
});
