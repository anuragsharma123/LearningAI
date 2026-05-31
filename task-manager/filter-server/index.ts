/**
 * Filter Rules MCP Server
 *
 * Stores user-defined rules that intercept task suggestions before they reach
 * the Task Manager. Each rule can either:
 *
 *   alert_only — surface the match to the user as a warning, skip task creation
 *   drop       — silently discard (no task, no alert)
 *
 * Typical use: emails that arrive due to an email-address collision (wrong person's
 * bills, notifications for accounts you don't own, etc.) should never become tasks
 * but you still want to know they arrived.
 *
 * Tools:
 *   add_filter_rule    — persist a new rule
 *   list_filter_rules  — show all active rules
 *   delete_filter_rule — remove a rule by ID
 *   apply_filters      — run a suggestion list through all rules; returns passed + alerts
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { FilterRule, AlertItem, FilterResult } from "./types.js";
import type { TaskSuggestion } from "../task-server/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, "rules.json");

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Reads all rules from disk. Returns [] if the file does not yet exist.
 */
async function loadRules(): Promise<FilterRule[]> {
  try {
    const raw = await fs.readFile(RULES_FILE, "utf8");
    return JSON.parse(raw) as FilterRule[];
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Overwrites the rules file with the provided array.
 */
async function saveRules(rules: FilterRule[]): Promise<void> {
  await fs.writeFile(RULES_FILE, JSON.stringify(rules, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Core filter logic
// ---------------------------------------------------------------------------

/**
 * Returns true if the suggestion's relevant fields contain the rule pattern
 * (case-insensitive substring match).
 *
 * @param suggestion - Task suggestion to test.
 * @param rule       - Rule to test against.
 */
function matches(suggestion: TaskSuggestion, rule: FilterRule): boolean {
  const pattern = rule.pattern.toLowerCase();

  const fields: string[] = [];
  if (rule.match_field === "title" || rule.match_field === "any") {
    fields.push(suggestion.title.toLowerCase());
  }
  if (rule.match_field === "description" || rule.match_field === "any") {
    fields.push((suggestion.description ?? "").toLowerCase());
  }

  return fields.some((f) => f.includes(pattern));
}

/**
 * Runs a list of task suggestions through all active rules.
 * Splits the list into:
 *   passed  — suggestions that did not match any rule (safe to create tasks)
 *   alerts  — suggestions that matched an `alert_only` rule (warn user, skip task)
 *   dropped — count of suggestions matched by `drop` rules (silently discarded)
 *
 * @param suggestions - Suggestions from the Gmail Agent.
 * @param rules       - All active filter rules.
 */
function applyAllRules(
  suggestions: TaskSuggestion[],
  rules: FilterRule[]
): FilterResult {
  const passed: TaskSuggestion[] = [];
  const alerts: AlertItem[] = [];
  let dropped_count = 0;

  for (const suggestion of suggestions) {
    const matchedRule = rules.find((r) => matches(suggestion, r));

    if (!matchedRule) {
      passed.push(suggestion);
    } else if (matchedRule.action === "alert_only") {
      alerts.push({
        suggestion,
        matched_rule: {
          id: matchedRule.id,
          name: matchedRule.name,
          action: matchedRule.action,
          reason: matchedRule.reason
        }
      });
    } else {
      // action === "drop"
      dropped_count++;
    }
  }

  return { passed, alerts, dropped_count };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: "filter-rules-server",
    version: "1.0.0",
    description: "Manages task-suggestion filtering rules for the Gmail Task Agent."
  },
  { capabilities: { tools: {} } }
);

// ── add_filter_rule ────────────────────────────────────────────────────────

/**
 * MCP Tool: add_filter_rule
 *
 * Persists a new rule that will intercept matching task suggestions.
 *
 * Example — alert on wrong person's electricity bill:
 *   pattern:     "HPSEBL"
 *   match_field: "title"
 *   action:      "alert_only"
 *   reason:      "Email ID collision — belongs to someone in Himachal Pradesh"
 *
 * @input name        - Short human-readable label for the rule.
 * @input pattern     - Case-insensitive substring to look for.
 * @input match_field - Which part of the suggestion to search: title | description | any.
 * @input action      - alert_only (warn + skip) or drop (silent discard).
 * @input reason      - Why this rule exists; shown in alert messages.
 */
server.registerTool(
  "add_filter_rule",
  {
    title: "Add Filter Rule",
    description: "Add a rule that intercepts matching task suggestions before they reach the task list.",
    inputSchema: z.object({
      name:        z.string().min(1).describe("Short label for this rule"),
      pattern:     z.string().min(1).describe("Case-insensitive substring to match"),
      match_field: z.enum(["title", "description", "any"]).describe("Which field to search"),
      action:      z.enum(["alert_only", "drop"]).describe("alert_only: warn user and skip task creation | drop: silently discard"),
      reason:      z.string().min(1).describe("Why this rule exists (shown in alert messages)")
    })
  },
  async ({ name, pattern, match_field, action, reason }) => {
    const rules = await loadRules();
    const rule: FilterRule = {
      id: randomUUID(),
      name,
      pattern,
      match_field,
      action,
      reason,
      createdAt: new Date().toISOString()
    };
    rules.push(rule);
    await saveRules(rules);
    return {
      content: [{
        type: "text",
        text: `Rule added: "${name}" (ID: ${rule.id})\n  Match: ${match_field} contains "${pattern}"\n  Action: ${action}\n  Reason: ${reason}`
      }]
    };
  }
);

// ── list_filter_rules ──────────────────────────────────────────────────────

/**
 * MCP Tool: list_filter_rules
 *
 * Returns all active filter rules formatted as a readable table.
 * Takes no input parameters.
 */
server.registerTool(
  "list_filter_rules",
  {
    title: "List Filter Rules",
    description: "Return all active filter rules."
  },
  async () => {
    const rules = await loadRules();
    if (rules.length === 0) {
      return { content: [{ type: "text", text: "No filter rules defined." }] };
    }

    const HEADERS = ["#", "Name", "Pattern", "Field", "Action", "Reason"];
    const rows = rules.map((r, i) => [
      String(i + 1), r.name, r.pattern, r.match_field, r.action, r.reason
    ]);
    const widths = HEADERS.map((h, col) =>
      Math.max(h.length, ...rows.map((r) => r[col].length))
    );
    const pad = (s: string, w: number) => s.padEnd(w);
    const divider = (l: string, m: string, r: string) =>
      l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
    const row = (cells: string[]) =>
      "│ " + cells.map((c, i) => pad(c, widths[i])).join(" │ ") + " │";

    const table = [
      divider("┌", "┬", "┐"),
      row(HEADERS),
      divider("├", "┼", "┤"),
      ...rows.map(row),
      divider("└", "┴", "┘")
    ].join("\n");

    return { content: [{ type: "text", text: table }] };
  }
);

// ── delete_filter_rule ─────────────────────────────────────────────────────

/**
 * MCP Tool: delete_filter_rule
 *
 * Permanently removes a rule by its UUID.
 * Use list_filter_rules to find the ID of the rule to remove.
 *
 * @input ruleId - UUID of the rule to delete.
 */
server.registerTool(
  "delete_filter_rule",
  {
    title: "Delete Filter Rule",
    description: "Remove a filter rule by its ID.",
    inputSchema: z.object({
      ruleId: z.string().uuid().describe("UUID of the rule to delete")
    })
  },
  async ({ ruleId }) => {
    const rules = await loadRules();
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    const [deleted] = rules.splice(idx, 1);
    await saveRules(rules);
    return {
      content: [{ type: "text", text: `Rule deleted: "${deleted.name}" (ID: ${deleted.id})` }]
    };
  }
);

// ── apply_filters ──────────────────────────────────────────────────────────

/**
 * MCP Tool: apply_filters
 *
 * Runs a list of task suggestions through all active rules and splits them into:
 *   passed  — safe to create as tasks
 *   alerts  — matched an alert_only rule; surface to user, skip task creation
 *   dropped — matched a drop rule; count only
 *
 * Called by the Gmail Subagent after collecting suggestions from Claude.
 *
 * @input suggestions - Array of TaskSuggestion objects to filter.
 * @returns JSON-encoded FilterResult: { passed, alerts, dropped_count }.
 */
server.registerTool(
  "apply_filters",
  {
    title: "Apply Filters",
    description: "Run task suggestions through all active rules. Returns passed suggestions and any alerts.",
    inputSchema: z.object({
      suggestions: z.array(z.object({
        title:       z.string(),
        description: z.string().optional(),
        source:      z.enum(["today", "recurring"])
      })).describe("Task suggestions to filter")
    })
  },
  async ({ suggestions }) => {
    const rules = await loadRules();
    const result = applyAllRules(suggestions as TaskSuggestion[], rules);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  }
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Starts the filter-rules MCP server on stdio.
 * Spawned by the Gmail Subagent at runtime; logs to stderr only.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Filter rules MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Failed to start filter server:", err);
  process.exit(1);
});
