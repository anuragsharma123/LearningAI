/**
 * Gmail MCP Server
 *
 * Wraps the Gmail Agent as a long-lived MCP server so the Orchestrator can
 * call it as a first-class tool instead of a hardcoded JavaScript function.
 *
 * Tools:
 *   fetch_gmail_suggestions — reads today's inbox + last 2 months, returns TaskSuggestion[]
 */

import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";

import { analyzeGmail } from "./gmail-agent/index.js";
import type { TaskSuggestion } from "../task-server/types.js";

dotenv.config();

const server = new McpServer(
  {
    name: "gmail-agent-server",
    version: "1.0.0",
    description: "Reads Gmail and returns structured task suggestions."
  },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "fetch_gmail_suggestions",
  {
    title: "Fetch Gmail Suggestions",
    description:
      "Read today's Gmail inbox and the last 2 months of emails. " +
      "Returns a JSON array of task suggestions — action items from today " +
      "and recurring obligations (bills, subscriptions) detected from email history.",
    inputSchema: z.object({
      memory_context: z
        .string()
        .optional()
        .describe("Known recurring patterns from previous runs, injected by the orchestrator.")
    })
  },
  async ({ memory_context = "" }) => {
    const suggestions: TaskSuggestion[] = await analyzeGmail(memory_context);
    return {
      content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }]
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gmail agent MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Failed to start Gmail server:", err);
  process.exit(1);
});
