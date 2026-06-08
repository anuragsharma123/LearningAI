import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  getAuthClient,
  getTodayEmails,
  getEmailsSince,
  type EmailSummary
} from "./gmail.js";
import type { TaskSuggestion } from "../../task-server/types.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Anthropic SDK instance used for all Claude API calls. */
const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Agent instructions loaded from `gmail-agent-prompt.md`.
 * Tells Claude how to extract tasks from emails and detect recurring patterns.
 */
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "../../", "gmail-agent-prompt.md"),
  "utf8"
);

/** Singleton MCP client connected to the spawned task manager server process. */
let mcpClient: Client;

// ---------------------------------------------------------------------------
// MCP helpers — same pattern as task-manager.ts
// ---------------------------------------------------------------------------

/**
 * Spawns `task-server/index.ts` as a child process via `tsx` and connects
 * the MCP client to it over stdio. Populates the module-level `mcpClient`.
 * Throws if the connection cannot be established.
 */
async function initializeMcpServer(): Promise<void> {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: [path.join(__dirname, "../../task-server/index.ts")],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  });

  mcpClient = new Client(
    { name: "gmail-task-agent", version: "1.0.0" },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  console.log("✓ Connected to task manager MCP server\n");
}

/**
 * Queries the MCP server for its registered tools and converts them to the
 * Anthropic SDK format so they can be passed directly to `messages.create`.
 *
 * @returns Array of Anthropic-compatible tool definitions.
 */
async function getAvailableTools(): Promise<Anthropic.Tool[]> {
  const response = await mcpClient.listTools();
  return response.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"]
  }));
}

/**
 * Executes a single MCP tool by name and returns its plain-text result.
 * Extracts the first `text` content block; falls back to a generic message.
 *
 * @param toolName  - Registered tool name (e.g. `"create_task"`).
 * @param toolInput - Arguments matching the tool's input schema.
 * @returns Text output from the tool.
 * @throws If the MCP server returns an error.
 */
async function callMcpTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  const result = await mcpClient.callTool({ name: toolName, arguments: toolInput });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "Tool executed successfully";
}

// ---------------------------------------------------------------------------
// Email formatting
// ---------------------------------------------------------------------------

/**
 * Renders a list of emails as a numbered plain-text block for Claude.
 * Each entry shows From, Subject, Date, and the snippet preview.
 * Returns a labelled "no emails" message when the array is empty.
 *
 * @param emails - Emails to format.
 * @param label  - Section heading (e.g. `"TODAY'S EMAILS"`).
 * @returns Multi-line string ready to embed in a Claude prompt.
 */
function formatEmailsForPrompt(emails: EmailSummary[], label: string): string {
  if (emails.length === 0) {
    return `${label}: No emails found.\n`;
  }

  const lines = emails.map((e, i) => {
    const parts = [
      `[${i + 1}] From:    ${e.from}`,
      `     Subject: ${e.subject}`,
      `     Date:    ${e.date}`,
      `     Preview: ${e.snippet}`
    ];
    if (e.body) parts.push(`     Body:    ${e.body}`);
    return parts.join("\n");
  });

  return `${label} (${emails.length} emails):\n\n${lines.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

/**
 * Runs the Gmail task agent as a single-shot agentic loop (no interactive REPL).
 *
 * Flow:
 * 1. Formats both email sets into a single user message.
 * 2. Calls Claude with the system prompt and task manager tools.
 * 3. While `stop_reason === "tool_use"`: executes each requested MCP tool,
 *    feeds results back to Claude, repeats.
 * 4. Prints Claude's final summary to stdout.
 *
 * Tool errors are caught per-tool and returned as error content so Claude
 * can react (report the failure or skip the task).
 *
 * @param todayEmails   - Full-format emails from today.
 * @param recentEmails  - Metadata-only emails from the last two months.
 */
async function runGmailAgent(
  todayEmails: EmailSummary[],
  recentEmails: EmailSummary[]
): Promise<void> {
  const tools = await getAvailableTools();

  const userMessage = [
    formatEmailsForPrompt(todayEmails, "TODAY'S EMAILS"),
    "---",
    formatEmailsForPrompt(recentEmails, "EMAILS FROM THE LAST 2 MONTHS")
  ].join("\n\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage }
  ];

  let response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools,
    messages
  });

  // Agentic loop: keep going until Claude stops requesting tools.
  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`[Task Manager] ${block.name}(${JSON.stringify(block.input)})`);
        try {
          const result = await callMcpTool(
            block.name,
            block.input as Record<string, unknown>
          );
          console.log(`  → ${result}\n`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`  ✗ ${msg}\n`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: msg
          });
        }
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages
    });
  }

  // Print Claude's final summary.
  for (const block of response.content) {
    if (block.type === "text") {
      console.log("\n" + block.text + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — used by the orchestrator
// ---------------------------------------------------------------------------

/**
 * The Anthropic tool definition used to force Claude to return structured
 * task suggestions instead of calling the MCP server directly.
 * `tool_choice` pins Claude to this tool so the output is always parseable JSON.
 */
const SUGGEST_TASKS_TOOL: Anthropic.Tool = {
  name: "suggest_tasks",
  description: "Return the list of tasks extracted from the emails.",
  input_schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short actionable task title (max 80 chars). For bills include company and amount."
            },
            description: {
              type: "string",
              description: "Optional context: deadline, amount due, billing cycle, etc."
            },
            source: {
              type: "string",
              enum: ["today", "recurring"],
              description: "'today' for action items found in today's emails, 'recurring' for pattern-detected obligations."
            }
          },
          required: ["title", "source"]
        }
      }
    },
    required: ["tasks"]
  }
};

/**
 * Gmail Agent public entry point — called by the orchestrator.
 *
 * Reads Gmail (today + last 2 months), asks Claude to extract task suggestions
 * via a forced `suggest_tasks` tool call, and returns the structured result.
 * Does **not** connect to the MCP server — that is the Task Manager Agent's job.
 *
 * @param memoryContext - Optional context string injected by the MemoryManager
 *   containing known recurring patterns from previous runs. When present, Claude
 *   uses this to recognise patterns it has seen before, even if worded differently.
 * @returns Array of {@link TaskSuggestion} objects ready to hand off to the Task Manager Agent.
 */
export async function analyzeGmail(memoryContext = "", sinceDate?: Date): Promise<TaskSuggestion[]> {
  const auth = await getAuthClient();

  const [todayEmails, recentEmails] = await Promise.all([
    getTodayEmails(auth),
    getEmailsSince(auth, sinceDate)   // sinceDate = last run; undefined = 2-month fallback
  ]);

  const windowLabel = sinceDate
    ? `since ${sinceDate.toISOString().slice(0, 10)}`
    : "last 2 months";
  console.log(
    `  ✓ ${todayEmails.length} emails today · ${recentEmails.length} emails ${windowLabel}`
  );

  const userMessage = [
    formatEmailsForPrompt(todayEmails, "TODAY'S EMAILS"),
    "---",
    formatEmailsForPrompt(recentEmails, `EMAILS FROM ${windowLabel.toUpperCase()}`),
    memoryContext
  ].join("\n\n");

  const response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [SUGGEST_TASKS_TOOL],
    // Force Claude to always call suggest_tasks — guarantees structured output.
    tool_choice: { type: "tool", name: "suggest_tasks" },
    messages: [{ role: "user", content: userMessage }]
  });

  // Extract the suggest_tasks call from the response.
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "suggest_tasks") {
      const input = block.input as { tasks: TaskSuggestion[] };
      return input.tasks ?? [];
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Entry point for the Gmail task agent.
 *
 * Start-up sequence:
 * 1. Connects to the task manager MCP server ({@link initializeMcpServer}).
 * 2. Authenticates with Gmail ({@link getAuthClient}).
 *    On first run, opens a browser OAuth flow and saves the token.
 * 3. Fetches today's emails and last-2-months emails in parallel.
 * 4. Runs the agentic loop ({@link runGmailAgent}) — Claude reads the emails,
 *    calls task manager tools to create/update tasks, then prints a summary.
 * 5. Closes the MCP client gracefully.
 *
 * Exits with code 1 on any unrecoverable error.
 */
async function main(): Promise<void> {
  console.log("Gmail Task Agent");
  console.log("=".repeat(40));

  try {
    console.log("\n[1/3] Connecting to task manager...");
    await initializeMcpServer();

    console.log("[2/3] Authenticating with Gmail...");
    const auth = await getAuthClient();
    console.log("✓ Gmail authenticated\n");

    console.log("[3/3] Fetching emails...");
    const [todayEmails, recentEmails] = await Promise.all([
      getTodayEmails(auth),
      getLastTwoMonthsEmails(auth)
    ]);
    console.log(
      `✓ ${todayEmails.length} emails today · ${recentEmails.length} emails over last 2 months\n`
    );

    console.log("Analysing emails and updating task list...");
    console.log("-".repeat(40) + "\n");

    await runGmailAgent(todayEmails, recentEmails);
  } catch (error) {
    console.error(
      "\nError:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  } finally {
    await mcpClient?.close();
  }
}

// Only run when executed directly (not when imported by gmail-server)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
