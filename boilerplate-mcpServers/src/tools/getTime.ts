import { z } from "zod";
import { defineTool } from "./types.js";

export const getTimeTool = defineTool({
  name: "get_time",
  description: "Returns the current time in the given IANA timezone (e.g. 'Asia/Kolkata').",
  inputSchema: {
    timezone: z
      .string()
      .default("UTC")
      .describe("IANA timezone name, e.g. 'Asia/Kolkata' or 'UTC'"),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: false, // returns a different value each call
    openWorldHint: false,
  },
  handler: async ({ timezone }) => {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: timezone,
    }).format(now);

    return {
      content: [{ type: "text", text: formatted }],
    };
  },
});
