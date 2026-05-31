/**
 * Orchestrator — true agent-to-agent (A2A) coordination.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FULL FLOW DIAGRAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  npm run orchestrator -- --run-now
 *           │
 *           ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │               ORCHESTRATOR AGENT  (Claude)              │
 *  │                                                         │
 *  │  Prompt: "Analyse my Gmail and update my task list"     │
 *  │  Tools:  [analyze_gmail]  [update_task_list]            │
 *  │                                                         │
 *  │  Claude reasons → decides to call analyze_gmail first   │
 *  └────────────────────┬────────────────────────────────────┘
 *                       │ tool_use: analyze_gmail
 *                       ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │               GMAIL SUBAGENT  (Claude)                  │
 *  │                                                         │
 *  │  1. getAuthClient()  ──────────────────► Gmail OAuth2   │
 *  │  2. getTodayEmails()  ─────────────────► Gmail API      │
 *  │     getLastTwoMonthsEmails()  ─────────► Gmail API      │
 *  │  3. Claude call (forced suggest_tasks tool)             │
 *  │     → returns raw TaskSuggestion[]                      │
 *  │                                                         │
 *  │  NOTE: MCP is NOT used here.                            │
 *  │  This agent only reads email — no task writes.          │
 *  └────────────────────┬────────────────────────────────────┘
 *                       │ raw TaskSuggestion[]
 *                       ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │           FILTER RULES MCP SERVER                       │
 *  │           filter-server/index.ts  (stdio)               │
 *  │                                                         │
 *  │  apply_filters(suggestions)                             │
 *  │    → reads rules.json                                   │
 *  │    → splits suggestions into three buckets:             │
 *  │                                                         │
 *  │  passed     ──► forwarded to Task Manager               │
 *  │  alert_only ──► printed as ⚠ warning; no task created  │
 *  │  drop       ──► silently discarded; counted only        │
 *  │                                                         │
 *  │  Example rule: HPSEBL electricity bill → alert_only     │
 *  │  (email-address collision; not the user's bill)         │
 *  └────────────────────┬────────────────────────────────────┘
 *                       │ { passed, alerts, dropped_count }
 *                       ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │               ORCHESTRATOR AGENT  (Claude)              │
 *  │                                                         │
 *  │  Receives filtered suggestions, reasons about them:     │
 *  │  "I have N suggestions — call update_task_list"         │
 *  │  (or: "0 suggestions — nothing to do, report back")     │
 *  └────────────────────┬────────────────────────────────────┘
 *                       │ tool_use: update_task_list(passed suggestions)
 *                       ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │           TASK MANAGER SUBAGENT  (Claude)               │
 *  │                                                         │
 *  │  Prompt: "Here are N suggestions, add new ones"         │
 *  │  Tools:  [list_tasks] [create_task] [update_task] ...   │
 *  │                    │                                    │
 *  │                    │ MCP stdio transport                │
 *  │                    ▼                                    │
 *  │         ┌──────────────────────┐                        │
 *  │         │   MCP SERVER         │                        │
 *  │         │   task-server/        │                        │
 *  │         │   index.ts           │                        │
 *  │         │                      │                        │
 *  │         │  list_tasks()   ──►  tasks.json (read)        │
 *  │         │  create_task()  ──►  tasks.json (write)       │
 *  │         └──────────────────────┘                        │
 *  │                                                         │
 *  │  Claude loops until all tasks created / deduplicated    │
 *  │  → returns plain-text summary                           │
 *  └────────────────────┬────────────────────────────────────┘
 *                       │ tool_result: "Created 3 tasks, skipped 1 duplicate"
 *                       ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │               ORCHESTRATOR AGENT  (Claude)              │
 *  │                                                         │
 *  │  Both subagents have reported back.                     │
 *  │  Claude writes final summary → printed to stdout.       │
 *  └─────────────────────────────────────────────────────────┘
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE MCP IS (AND IS NOT) USED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  ✅  Task Manager Subagent  — connects to task MCP server over stdio.
 *                               Claude calls list_tasks / create_task via MCP.
 *                               MCP reads/writes tasks.json.
 *
 *  ✅  Gmail Subagent         — connects to filter-rules MCP server over stdio.
 *                               Calls apply_filters; MCP reads rules.json.
 *                               Server is spawned per-run and closed after.
 *
 *  ❌  Orchestrator Agent     — does NOT use MCP.
 *                               Its tools are the two subagents, not MCP tools.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCHEDULING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  node-cron: "0 9 1,15 * *"  →  09:00 on the 1st and 15th of every month.
 *  Manual:    npm run orchestrator -- --run-now
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";
import cron from "node-cron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { analyzeGmail } from "./gmail-agent/index.js";
import type { TaskSuggestion } from "./task-server/types.js";
import type { FilterResult, AlertItem } from "./filter-server/types.js";
import { MemoryManager } from "./memory/index.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const ORCHESTRATOR_PROMPT = fs.readFileSync(
  path.join(__dirname, "orchestrator-prompt.md"),
  "utf8"
);

const TASK_MANAGER_PROMPT = fs.readFileSync(
  path.join(__dirname, "system-prompt.md"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Orchestrator tool definitions
// Each tool = one subagent. Claude decides when to invoke them.
// ---------------------------------------------------------------------------

/**
 * Tools available to the Orchestrator Agent.
 * These are not MCP tools — each one spins up a specialist Claude subagent.
 */
const ORCHESTRATOR_TOOLS: Anthropic.Tool[] = [
  {
    name: "analyze_gmail",
    description:
      "Invoke the Gmail Subagent to read today's inbox and the last 2 months " +
      "of emails. Returns a list of task suggestions: action items from today " +
      "and recurring obligations (bills, subscriptions) from the email history.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "update_task_list",
    description:
      "Invoke the Task Manager Subagent to process task suggestions and add " +
      "them to the task list. Automatically skips duplicates. Returns a summary " +
      "of what was created.",
    input_schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          description: "Task suggestions produced by analyze_gmail.",
          items: {
            type: "object",
            properties: {
              title:       { type: "string" },
              description: { type: "string" },
              source:      { type: "string", enum: ["today", "recurring"] }
            },
            required: ["title", "source"]
          }
        }
      },
      required: ["suggestions"]
    }
  }
];

// ---------------------------------------------------------------------------
// Subagent: Gmail
// ---------------------------------------------------------------------------

/**
 * Spawns the filter-rules MCP server and returns a connected client.
 * The caller is responsible for calling `client.close()`.
 */
async function createFilterClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: [path.join(__dirname, "filter-server/index.ts")],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  });
  const client = new Client(
    { name: "orchestrator-filter-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

/**
 * Runs all task suggestions through the filter-rules MCP server.
 * Returns the FilterResult containing passed suggestions, alert_only matches,
 * and a count of silently dropped suggestions.
 *
 * @param client      - Connected filter MCP client.
 * @param suggestions - Raw suggestions from the Gmail Agent.
 */
async function runFilters(
  client: Client,
  suggestions: TaskSuggestion[]
): Promise<FilterResult> {
  const result = await client.callTool({
    name: "apply_filters",
    arguments: { suggestions }
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as FilterResult;
}

/**
 * Gmail Subagent — invoked when the Orchestrator calls the `analyze_gmail` tool.
 *
 * Flow:
 * 1. Injects confirmed recurring patterns from memory into the Gmail prompt.
 * 2. Calls analyzeGmail() → raw TaskSuggestion[].
 * 3. Runs suggestions through the Filter Rules MCP server:
 *    - passed      → forwarded to the Task Manager
 *    - alert_only  → printed as warnings; task NOT created
 *    - drop        → silently discarded
 * 4. Stores newly found recurring patterns in memory.
 *
 * @param memory - Shared MemoryManager for this pipeline run.
 * @returns JSON string of `{ suggestions, alerts }` for the Orchestrator.
 */
async function gmailSubagent(memory: MemoryManager): Promise<string> {
  console.log("\n  ┌─ Gmail Subagent invoked");

  // Inject confirmed patterns from previous runs into the prompt.
  const memoryContext = await memory.buildGmailContext();
  if (memoryContext) console.log("  │  [Memory] Injecting known patterns");

  const rawSuggestions = await analyzeGmail(memoryContext);
  console.log(`  │  Raw suggestions: ${rawSuggestions.length}`);

  // Run through filter rules MCP server.
  const filterClient = await createFilterClient();
  let filterResult: FilterResult;
  try {
    filterResult = await runFilters(filterClient, rawSuggestions);
  } finally {
    await filterClient.close();
  }

  const { passed, alerts, dropped_count } = filterResult;

  // Print alerts immediately — the user should know about these emails.
  if (alerts.length > 0) {
    console.log("\n  ┌─ ⚠  FILTER ALERTS (emails received — no tasks created) ─────────");
    for (const alert of alerts as AlertItem[]) {
      console.log(`  │  📬 "${alert.suggestion.title}"`);
      console.log(`  │     Rule: ${alert.matched_rule.name}`);
      console.log(`  │     Reason: ${alert.matched_rule.reason}`);
    }
    console.log("  └────────────────────────────────────────────────────────────────\n");
  }

  if (dropped_count > 0) {
    console.log(`  │  [Filter] Silently dropped ${dropped_count} suggestion(s)`);
  }

  // Persist newly discovered recurring patterns for future runs.
  for (const s of passed.filter((s) => s.source === "recurring")) {
    const parts = s.title.split(/\s[–-]\s/);
    await memory.storeEmailPattern(
      parts[0]?.replace(/^pay\s+/i, "").toLowerCase().trim() ?? s.title,
      s.title,
      parts[1]?.trim() ?? ""
    );
  }

  console.log(`  └─ Gmail Subagent: ${passed.length} passed · ${alerts.length} alerts · ${dropped_count} dropped`);

  // Return both passed suggestions and alerts so the Orchestrator can
  // mention the alerts in its final summary.
  return JSON.stringify({ suggestions: passed, alerts });
}

// ---------------------------------------------------------------------------
// Subagent: Task Manager
// ---------------------------------------------------------------------------

/**
 * MCP helpers scoped to the Task Manager Subagent.
 */
async function createMcpClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: [path.join(__dirname, "task-server/index.ts")],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  });
  const client = new Client(
    { name: "orchestrator-task-subagent", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

async function getMcpTools(client: Client): Promise<Anthropic.Tool[]> {
  const response = await client.listTools();
  return response.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"]
  }));
}

async function callMcpTool(
  client: Client,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name: toolName, arguments: toolInput });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "Tool executed successfully";
}

/**
 * Task Manager Subagent — invoked when the Orchestrator calls `update_task_list`.
 *
 * Injects recently created tasks from memory so Claude can perform semantic
 * deduplication beyond the MCP server's exact-match check. After the loop,
 * stores each successfully created task into memory for future runs.
 *
 * @param suggestions - Task suggestions passed down from the Orchestrator.
 * @param memory      - Shared MemoryManager instance for this pipeline run.
 * @param runId       - Current run ID, stamped on every stored task record.
 * @returns Plain-text summary of what was created, to report back to the Orchestrator.
 */
async function taskManagerSubagent(
  suggestions: TaskSuggestion[],
  memory: MemoryManager,
  runId: string
): Promise<{ summary: string; created: number; skipped: number }> {
  console.log(`\n  ┌─ Task Manager Subagent invoked (${suggestions.length} suggestion(s))`);

  if (suggestions.length === 0) {
    console.log("  └─ No suggestions — nothing to do");
    return { summary: "No suggestions were provided. Task list unchanged.", created: 0, skipped: 0 };
  }

  // Pre-filter using vector similarity — catch semantic duplicates before Claude even sees them.
  const filtered: TaskSuggestion[] = [];
  const preSkipped: TaskSuggestion[] = [];
  for (const s of suggestions) {
    if (await memory.isSemanticDuplicate(s.title)) {
      console.log(`  │  [Memory] Semantic duplicate skipped: "${s.title}"`);
      preSkipped.push(s);
    } else {
      filtered.push(s);
    }
  }

  const mcpClient = await createMcpClient();

  try {
    const tools = await getMcpTools(mcpClient);

    // Inject recent task history so Claude can apply its own deduplication on top.
    const memoryContext = await memory.buildTaskManagerContext();
    const suggestionList = filtered
      .map((s, i) => {
        const label = s.source === "recurring" ? "[RECURRING]" : "[TODAY]";
        const desc = s.description ? `\n   Description: ${s.description}` : "";
        return `${i + 1}. ${label} ${s.title}${desc}`;
      })
      .join("\n");

    const userMessage =
      `The Gmail Agent identified these tasks from my inbox.\n` +
      `Check the existing task list and add any that don't already exist.\n\n` +
      `Suggestions:\n${suggestionList}` +
      memoryContext;

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage }
    ];

    let response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: TASK_MANAGER_PROMPT,
      tools,
      messages
    });

    // Track which suggestions were actually created via create_task calls.
    let createdCount = preSkipped.length > 0 ? 0 : 0;
    const createdTitles = new Set<string>();

    // Task Manager Subagent's own agentic loop.
    while (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`  │  [MCP] ${block.name}(${JSON.stringify(block.input)})`);
          try {
            const result = await callMcpTool(
              mcpClient,
              block.name,
              block.input as Record<string, unknown>
            );
            console.log(`  │    → ${result}`);

            // Count successful create_task calls and record which suggestion was created.
            if (block.name === "create_task") {
              const input = block.input as { title?: string };
              if (input.title) createdTitles.add(input.title.toLowerCase());
              createdCount++;
            }

            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`  │    ✗ ${msg}`);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: msg });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });

      response = await anthropicClient.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: TASK_MANAGER_PROMPT,
        tools,
        messages
      });
    }

    // Persist created tasks into memory for semantic deduplication on future runs.
    for (const s of filtered) {
      if (createdTitles.has(s.title.toLowerCase())) {
        await memory.storeTask(s, runId);
      }
    }

    const skippedCount = preSkipped.length + (filtered.length - createdCount);
    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    console.log("  └─ Task Manager Subagent complete");
    return { summary, created: createdCount, skipped: skippedCount };
  } finally {
    await mcpClient.close();
  }
}

// ---------------------------------------------------------------------------
// Orchestrator Agent
// ---------------------------------------------------------------------------

/**
 * Runs the Orchestrator Agent — a Claude reasoning loop that decides when
 * to invoke the Gmail Subagent and Task Manager Subagent.
 *
 * This is the core of A2A communication:
 * - The Orchestrator is NOT a hardcoded script.
 * - Claude reads the available subagent tools and reasons about the flow.
 * - Subagents are invoked as tool calls; their results feed back into
 *   Claude's context so it can decide what to do next.
 */
async function runOrchestratorAgent(): Promise<void> {
  console.log("\n[Orchestrator Agent] Starting reasoning loop...\n");

  // Initialise memory once per run and share across both subagents.
  const memory = new MemoryManager();
  await memory.init();

  const runId = `run-${Date.now()}`;
  let totalCreated = 0;
  let totalSkipped = 0;
  let finalSummary = "";

  // Inject recent run history into the orchestrator's system prompt.
  const runHistory = await memory.buildOrchestratorContext();
  const systemWithMemory = ORCHESTRATOR_PROMPT + runHistory;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: "Please analyse my Gmail inbox and keep my task list up to date."
    }
  ];

  let response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemWithMemory,
    tools: ORCHESTRATOR_TOOLS,
    messages
  });

  // Orchestrator's agentic loop — each tool_use invokes a subagent.
  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`[Orchestrator] → invoking subagent: ${block.name}`);

        let result: string;

        if (block.name === "analyze_gmail") {
          // Returns JSON: { suggestions: TaskSuggestion[], alerts: AlertItem[] }
          // Filters have already been applied and alerts already printed to console.
          result = await gmailSubagent(memory);

        } else if (block.name === "update_task_list") {
          // The Orchestrator passes suggestions from the analyze_gmail result.
          // Unpack in case it received the full { suggestions, alerts } envelope.
          const raw = block.input as { suggestions: TaskSuggestion[] | { suggestions: TaskSuggestion[] } };
          const suggestions = Array.isArray(raw.suggestions)
            ? raw.suggestions
            : (raw.suggestions as unknown as { suggestions: TaskSuggestion[] }).suggestions ?? [];
          const input = { suggestions };
          // Pass memory for semantic dedup + task storage; pass runId for provenance.
          const outcome = await taskManagerSubagent(input.suggestions, memory, runId);
          totalCreated += outcome.created;
          totalSkipped += outcome.skipped;
          finalSummary = outcome.summary;
          result = outcome.summary;

        } else {
          result = `Unknown subagent: ${block.name}`;
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemWithMemory,
      tools: ORCHESTRATOR_TOOLS,
      messages
    });
  }

  // Orchestrator's final reasoning output.
  for (const block of response.content) {
    if (block.type === "text") {
      finalSummary = finalSummary || block.text;
      console.log("\n" + block.text);
    }
  }

  // Store this run in memory so future runs can see what happened today.
  await memory.storeRun(runId, totalCreated + totalSkipped, totalCreated, totalSkipped, finalSummary);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Starts the cron scheduler. Runs at 09:00 on the 1st and 15th of each month.
 *
 * Cron: `0 9 1,15 * *`
 */
function startScheduler(): void {
  const SCHEDULE = "0 9 1,15 * *";

  cron.schedule(SCHEDULE, () => {
    const stamp = new Date().toLocaleString();
    console.log(`\n${"=".repeat(50)}\nScheduled run — ${stamp}\n${"=".repeat(50)}`);
    runOrchestratorAgent().catch((err) =>
      console.error("Pipeline error:", err instanceof Error ? err.message : String(err))
    );
  });

  console.log("Orchestrator scheduled — 09:00 on the 1st and 15th of each month.");
  console.log("Press Ctrl+C to stop.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Usage:
 *   npm run orchestrator              → start scheduler
 *   npm run orchestrator -- --run-now → run once immediately
 */
async function main(): Promise<void> {
  const stamp = new Date().toLocaleString();
  console.log(`${"=".repeat(50)}\nOrchestrator — ${stamp}\n${"=".repeat(50)}`);

  if (process.argv.includes("--run-now")) {
    await runOrchestratorAgent();
  } else {
    startScheduler();
  }
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
