/**
 * Orchestrator — fully agentic, all tools through MCP.
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
 *  │  One agent — all tools from three MCP servers merged    │
 *  │  into a single tool list. Claude decides order/logic.   │
 *  │                                                         │
 *  │  Tools available:                                       │
 *  │    fetch_gmail_suggestions  ← gmail-server              │
 *  │    apply_filters            ← filter-server             │
 *  │    add/list/delete_filter_rule                          │
 *  │    create/list/get/update/complete/delete_task          │
 *  └──────────────────────┬──────────────────────────────────┘
 *                         │ tool: fetch_gmail_suggestions
 *                         ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │           GMAIL MCP SERVER  (long-lived process)        │
 *  │           gmail-server/index.ts                         │
 *  │                                                         │
 *  │  1. getTodayEmails() + getLastTwoMonthsEmails()         │
 *  │  2. Claude (internal, forced tool_choice)               │
 *  │     → returns raw TaskSuggestion[]                      │
 *  └──────────────────────┬──────────────────────────────────┘
 *                         │ raw TaskSuggestion[] (JSON)
 *                         │ tool: apply_filters
 *                         ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │           FILTER MCP SERVER  (long-lived process)       │
 *  │           filter-server/index.ts                        │
 *  │                                                         │
 *  │  Reads rules.json, splits suggestions into:             │
 *  │    passed     → forwarded to task creation              │
 *  │    alert_only → ⚠ printed by routing layer; no task    │
 *  │    drop       → silently discarded; counted only        │
 *  └──────────────────────┬──────────────────────────────────┘
 *                         │ { passed, alerts, dropped_count }
 *                         │ tools: list_tasks, create_task (×N)
 *                         ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │           TASK MCP SERVER  (long-lived process)         │
 *  │           task-server/index.ts                          │
 *  │                                                         │
 *  │  list_tasks()   → tasks.json (read — for dedup)         │
 *  │  create_task()  → tasks.json (write)                    │
 *  └──────────────────────┬──────────────────────────────────┘
 *                         │ "Task created: X (ID: ...)"
 *                         ▼
 *  ┌─────────────────────────────────────────────────────────┐
 *  │               ORCHESTRATOR AGENT  (Claude)              │
 *  │                                                         │
 *  │  All tool results back in context.                      │
 *  │  Claude writes final summary → printed to stdout.       │
 *  └─────────────────────────────────────────────────────────┘
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE MCP IS USED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  ✅  Gmail MCP Server   — long-lived; Claude calls fetch_gmail_suggestions.
 *  ✅  Filter MCP Server  — long-lived; Claude calls apply_filters.
 *  ✅  Task MCP Server    — long-lived; Claude calls list_tasks / create_task.
 *  ❌  Orchestrator       — does NOT use MCP. It is the MCP client.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROUTING LAYER (transparent to Claude)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  fetch_gmail_suggestions — injects memory_context before forwarding
 *                          — stores new recurring patterns after result
 *  apply_filters           — prints ⚠ alerts to console after result
 *  create_task             — semantic-dedup check before forwarding
 *                          — stores new task in memory after success
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

import type { TaskSuggestion } from "./task-server/types.js";
import type { FilterResult, AlertItem } from "./filter-server/types.js";
import { MemoryManager } from "./memory/index.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_SERVER_URL = process.env.API_SERVER_URL ?? "http://localhost:3001";
const API_KEY        = process.env.API_KEY ?? "";

/** Fire-and-forget POST to the API server's internal event webhook. */
async function postEvent(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${API_SERVER_URL}/internal/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(payload)
    });
  } catch { /* non-fatal — API server may not be running */ }
}

const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ORCHESTRATOR_PROMPT = fs.readFileSync(
  path.join(__dirname, "orchestrator-prompt.md"),
  "utf8"
);

// ---------------------------------------------------------------------------
// MCP server registry — one entry per long-lived server process
// ---------------------------------------------------------------------------

const MCP_SERVERS = {
  gmail:  { command: "tsx", args: [path.join(__dirname, "gmail-server/index.ts")] },
  filter: { command: "tsx", args: [path.join(__dirname, "filter-server/index.ts")] },
  task:   { command: "tsx", args: [path.join(__dirname, "task-server/index.ts")] }
} as const;

// ---------------------------------------------------------------------------
// Connect all MCP servers and build a merged tool list + routing map
// ---------------------------------------------------------------------------

async function connectMcpServers(): Promise<{
  clients: Map<string, Client>;
  tools: Anthropic.Tool[];
  toolRouter: Map<string, Client>;
}> {
  const clients = new Map<string, Client>();
  const tools: Anthropic.Tool[] = [];
  const toolRouter = new Map<string, Client>();

  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
  );

  for (const [name, server] of Object.entries(MCP_SERVERS)) {
    const transport = new StdioClientTransport({ command: server.command, args: [...server.args], env });
    const client = new Client({ name: `orchestrator-${name}`, version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    clients.set(name, client);

    const { tools: serverTools } = await client.listTools();
    for (const tool of serverTools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool["input_schema"]
      });
      toolRouter.set(tool.name, client);
    }

    console.log(`  ✓ ${name.padEnd(6)} server: ${serverTools.map((t) => t.name).join(", ")}`);
  }

  return { clients, tools, toolRouter };
}

// ---------------------------------------------------------------------------
// Tool routing layer — transparent to Claude
// ---------------------------------------------------------------------------

async function callTool(
  toolRouter: Map<string, Client>,
  toolName: string,
  toolInput: Record<string, unknown>,
  memory: MemoryManager,
  runCtx: {
    rawSuggestions: TaskSuggestion[];
    runId: string;
    lastRunTimestamp?: string;
    setRawSuggestions: (s: TaskSuggestion[]) => void;
  }
): Promise<string> {
  const client = toolRouter.get(toolName);
  if (!client) throw new Error(`No MCP server handles tool: ${toolName}`);

  // ── Pre-call intercepts ──────────────────────────────────────────────────

  if (toolName === "fetch_gmail_suggestions") {
    const memCtx = await memory.buildGmailContext();
    if (memCtx) {
      toolInput = { ...toolInput, memory_context: memCtx };
      console.log("  │  [Memory] Injecting known patterns");
    }
    if (runCtx.lastRunTimestamp) {
      toolInput = { ...toolInput, since_date: runCtx.lastRunTimestamp };
      console.log(`  │  [Memory] Fetching emails since last run: ${runCtx.lastRunTimestamp.slice(0, 10)}`);
    }
  }

  if (toolName === "create_task") {
    const title = (toolInput as { title?: string }).title ?? "";
    if (await memory.isSemanticDuplicate(title)) {
      console.log(`  │  [Memory] Semantic duplicate skipped: "${title}"`);
      return `Skipped — semantically similar task already exists: "${title}"`;
    }
  }

  // ── MCP call ─────────────────────────────────────────────────────────────

  const result = await client.callTool({ name: toolName, arguments: toolInput });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .find((c) => c.type === "text")?.text ?? "";

  // ── Post-call intercepts ─────────────────────────────────────────────────

  if (toolName === "fetch_gmail_suggestions") {
    try {
      const suggestions = JSON.parse(text) as TaskSuggestion[];
      runCtx.setRawSuggestions(suggestions);
      for (const s of suggestions.filter((s) => s.source === "recurring")) {
        const parts = s.title.split(/\s[–-]\s/);
        await memory.storeEmailPattern(
          parts[0]?.replace(/^pay\s+/i, "").toLowerCase().trim() ?? s.title,
          s.title,
          parts[1]?.trim() ?? ""
        );
      }
    } catch { /* non-fatal — memory is best-effort */ }
  }

  if (toolName === "apply_filters") {
    try {
      const filterResult = JSON.parse(text) as FilterResult;
      if (filterResult.alerts?.length > 0) {
        console.log("\n  ┌─ ⚠  FILTER ALERTS (emails received — no tasks created) ─────────");
        for (const alert of filterResult.alerts as AlertItem[]) {
          console.log(`  │  📬 "${alert.suggestion.title}"`);
          console.log(`  │     Rule:   ${alert.matched_rule.name}`);
          console.log(`  │     Reason: ${alert.matched_rule.reason}`);
          // Broadcast to UI via API server
          postEvent({ type: "filter_alert", suggestion: alert.suggestion, matched_rule: alert.matched_rule });
        }
        console.log("  └────────────────────────────────────────────────────────────────\n");
      }
      if (filterResult.dropped_count > 0) {
        console.log(`  │  [Filter] Silently dropped ${filterResult.dropped_count} suggestion(s)`);
      }
    } catch { /* non-fatal */ }
  }

  if (toolName === "create_task" && text.startsWith("Task created:")) {
    try {
      const input = toolInput as { title?: string; description?: string };
      const matched = runCtx.rawSuggestions.find(
        (s) => s.title.toLowerCase() === (input.title ?? "").toLowerCase()
      );
      if (matched) await memory.storeTask(matched, runCtx.runId);
      // Broadcast to UI via API server
      postEvent({ type: "task_created", title: input.title, description: input.description });
    } catch { /* non-fatal */ }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Orchestrator Agent — single Claude loop over all MCP tools
// ---------------------------------------------------------------------------

async function runOrchestratorAgent(): Promise<void> {
  console.log("\n[Orchestrator] Connecting to MCP servers...");

  const memory = new MemoryManager();
  await memory.init();

  const runId = `run-${Date.now()}`;
  let rawSuggestions: TaskSuggestion[] = [];
  let totalCreated = 0;
  let totalSkipped = 0;

  // Get last run timestamp so Gmail fetch is scoped to new emails only
  const recentRuns = await memory.getRecentRuns(1);
  const lastRunTimestamp = recentRuns[0]?.timestamp;

  const { clients, tools, toolRouter } = await connectMcpServers();

  // Inject run history + recent tasks into the system prompt
  const runHistory = await memory.buildOrchestratorContext();
  const taskContext = await memory.buildTaskManagerContext();
  const systemPrompt = ORCHESTRATOR_PROMPT + runHistory + taskContext;

  console.log("\n[Orchestrator] Starting reasoning loop...\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Please analyse my Gmail inbox and keep my task list up to date." }
  ];

  let response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages
  });

  // Agentic loop — Claude calls tools until it reaches end_turn
  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const inputPreview = JSON.stringify(block.input);
      console.log(`[Orchestrator] → ${block.name}(${inputPreview.slice(0, 80)}${inputPreview.length > 80 ? "..." : ""})`);

      try {
        const result = await callTool(
          toolRouter,
          block.name,
          block.input as Record<string, unknown>,
          memory,
          {
            rawSuggestions,
            runId,
            lastRunTimestamp,
            setRawSuggestions: (s) => { rawSuggestions = s; }
          }
        );

        console.log(`  → ${result.slice(0, 120)}${result.length > 120 ? "..." : ""}`);

        if (block.name === "create_task" && result.startsWith("Task created:")) totalCreated++;
        if (block.name === "create_task" && result.startsWith("Skipped")) totalSkipped++;

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${msg}`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${msg}` });
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages
    });
  }

  // Print Claude's final summary
  let finalSummary = "";
  for (const block of response.content) {
    if (block.type === "text") {
      finalSummary = block.text;
      console.log("\n" + block.text);
    }
  }

  // Persist this run in memory for future context
  const total = totalCreated + totalSkipped;
  await memory.storeRun(runId, total, totalCreated, totalSkipped, finalSummary);

  // Gracefully close all MCP server connections
  for (const client of clients.values()) {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

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
