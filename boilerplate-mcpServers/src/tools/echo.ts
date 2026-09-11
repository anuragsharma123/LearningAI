import { z } from "zod";
import { defineTool } from "./types.js";

export const echoTool = defineTool({
  name: "echo",
  description: "Echoes back the provided message. Useful as a minimal template for new tools.",
  inputSchema: {
    message: z.string().describe("Text to echo back"),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async ({ message }) => {
    return {
      content: [{ type: "text", text: message }],
    };
  },
});
