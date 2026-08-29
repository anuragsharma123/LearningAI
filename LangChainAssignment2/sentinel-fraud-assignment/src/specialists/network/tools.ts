import { tool } from "langchain";
import { z } from "zod";
import { getSharedDevices, getMerchantCoincidence } from "./queries.js";

export const getSharedDevicesTool = tool(
  async ({ accountId }) => JSON.stringify(getSharedDevices(accountId)),
  {
    name: "get_shared_devices",
    description:
      "Returns every device this account's customer has used, each with a sharedWith list of " +
      "any OTHER customers who have also used that same device. An empty sharedWith list means " +
      "the device is exclusive to this customer -- normal. A non-empty list is the strongest " +
      "signal you have: only 16 of 1,520 devices in the whole bank are shared between " +
      "customers at all. Sharing could be a mule ring or a family sharing a tablet -- you " +
      "cannot tell which from this alone, but it is always worth surfacing.",
    schema: z.object({
      accountId: z.string().describe("The account id, e.g. A00985"),
    }),
  }
);

export const getMerchantCoincidenceTool = tool(
  async ({ accountId, sinceTs, windowHours }) =>
    JSON.stringify(getMerchantCoincidence(accountId, sinceTs, windowHours)),
  {
    name: "get_merchant_coincidence",
    description:
      "Returns this account's transactions, each annotated with how many OTHER accounts " +
      "transacted at the SAME merchant within +/- windowHours (default 48) of this account's " +
      "transaction. This is a weaker, directional signal, not a hard threshold -- every " +
      "merchant naturally has some coincidental overlap. Weigh it together with merchant " +
      "category and risk_score: high coincidence at a high-risk merchant (moneytransfer, " +
      "crypto, giftcard, gaming -- risk_score above ~0.5) is more meaningful than the same " +
      "count at an everyday merchant (grocery, fuel), where overlap is expected and unremarkable.",
    schema: z.object({
      accountId: z.string().describe("The account id, e.g. A00985"),
      sinceTs: z
        .string()
        .optional()
        .describe("ISO timestamp; only consider this account's transactions at or after this time"),
      windowHours: z
        .number()
        .optional()
        .describe("Coincidence window size in hours either side of each transaction; default 48"),
    }),
  }
);
