/**
 * Filter Rules CLI — interactive shell for managing Gmail task filter rules.
 *
 * Connects to the Filter Rules MCP server and gives Claude access to:
 *   add_filter_rule    — define a new pattern to intercept
 *   list_filter_rules  — show all active rules
 *   delete_filter_rule — remove a rule by ID
 *
 * Usage:
 *   npm run filters
 *
 * Example prompts:
 *   "Add a rule to alert me about HPSEBL electricity bills but not create tasks"
 *   "Show all filter rules"
 *   "Delete the HPSEBL rule"
 */

import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";
import * as readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "filter-cli-prompt.md"),
  "utf8"
);

let mcpClient: Client;
const conversationHistory: Anthropic.MessageParam[] = [];

async function initFilterServer(): Promise<void> {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: [path.join(__dirname, "filter-server/index.ts")],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  });
  mcpClient = new Client(
    { name: "filter-cli", version: "1.0.0" },
    { capabilities: {} }
  );
  await mcpClient.connect(transport);
  console.log("✓ Connected to filter rules server\n");
}

async function getTools(): Promise<Anthropic.Tool[]> {
  const response = await mcpClient.listTools();
  return response.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"]
  }));
}

async function callTool(name: string, input: Record<string, unknown>): Promise<string> {
  const result = await mcpClient.callTool({ name, arguments: input });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "Done.";
}

async function chat(userMessage: string, tools: Anthropic.Tool[]): Promise<void> {
  conversationHistory.push({ role: "user", content: userMessage });

  let response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
    messages: conversationHistory
  });

  while (response.stop_reason === "tool_use") {
    conversationHistory.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        try {
          const result = await callTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: msg });
        }
      }
    }

    conversationHistory.push({ role: "user", content: toolResults });
    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages: conversationHistory
    });
  }

  conversationHistory.push({ role: "assistant", content: response.content });
  for (const block of response.content) {
    if (block.type === "text") console.log(`\nAssistant: ${block.text}\n`);
  }
}

async function main(): Promise<void> {
  console.log("Filter Rules Manager");
  console.log("=".repeat(40));
  console.log('Type rules in plain English. Type "exit" to quit.\n');

  await initFilterServer();
  const tools = await getTools();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => {
    rl.question("You: ", async (input) => {
      if (input.toLowerCase() === "exit") {
        rl.close();
        await mcpClient.close();
        process.exit(0);
      }
      try {
        await chat(input, tools);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
      }
      ask();
    });
  };
  ask();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
