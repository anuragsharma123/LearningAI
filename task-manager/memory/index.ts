/**
 * MemoryManager — persistent vector memory for the orchestrator pipeline.
 *
 * Backed by LanceDB (embedded, no server) with local embeddings.
 * Three tables:
 *
 *   email_patterns  — recurring email patterns seen across runs
 *   task_history    — tasks created by the Task Manager Subagent
 *   run_history     — summary of every pipeline run
 *
 * Used to move the system from Level 3/4 (agentic loop + multi-agent) to
 * Level 5 (persistent memory, cross-run learning, semantic deduplication).
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embed, cosineSimilarity } from "./embeddings.js";
import type { EmailPatternRecord, TaskRecord, RunRecord } from "./schemas.js";
import type { TaskSuggestion } from "../task-server/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", ".lancedb");

/** Similarity threshold above which two tasks are considered duplicates. */
const DUPLICATE_THRESHOLD = 0.88;

/** Similarity threshold for recognising a known email pattern. */
const PATTERN_THRESHOLD = 0.82;

export class MemoryManager {
  private db!: lancedb.Connection;
  private emailPatterns!: lancedb.Table;
  private taskHistory!: lancedb.Table;
  private runHistory!: lancedb.Table;

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /**
   * Opens (or creates) the LanceDB database and ensures all three tables exist.
   * Must be called once before any other method.
   */
  async init(): Promise<void> {
    this.db = await lancedb.connect(DB_PATH);
    const existing = await this.db.tableNames();

    this.emailPatterns = existing.includes("email_patterns")
      ? await this.db.openTable("email_patterns")
      : await this.db.createTable("email_patterns", [this.emptyEmailPattern()]);

    this.taskHistory = existing.includes("task_history")
      ? await this.db.openTable("task_history")
      : await this.db.createTable("task_history", [this.emptyTaskRecord()]);

    this.runHistory = existing.includes("run_history")
      ? await this.db.openTable("run_history")
      : await this.db.createTable("run_history", [this.emptyRunRecord()]);

    console.log("  [Memory] Connected to LanceDB at", DB_PATH);
  }

  // ---------------------------------------------------------------------------
  // Email patterns
  // ---------------------------------------------------------------------------

  /**
   * Stores a newly detected recurring email pattern.
   * If a similar pattern already exists, increments its occurrence count instead.
   *
   * @param sender_domain    - e.g. `"att.com"`
   * @param subject_template - e.g. `"Your AT&T bill is ready"`
   * @param amount           - e.g. `"$79.99"` (empty string if unknown)
   */
  async storeEmailPattern(
    sender_domain: string,
    subject_template: string,
    amount: string
  ): Promise<void> {
    const text = `${sender_domain} ${subject_template} ${amount}`.toLowerCase().trim();
    const vector = await embed(text);

    const existing = await this.findSimilarPatterns(text, 1);
    if (existing.length > 0 && cosineSimilarity(vector, existing[0].vector) > PATTERN_THRESHOLD) {
      // Update existing pattern's occurrence count.
      await this.emailPatterns.delete(`id = '${existing[0].id}'`);
      await this.emailPatterns.add([{
        ...existing[0],
        occurrence_count: existing[0].occurrence_count + 1,
        last_seen: new Date().toISOString(),
        amount: amount || existing[0].amount
      }]);
    } else {
      const record: EmailPatternRecord = {
        id: randomUUID(),
        text,
        sender_domain,
        subject_template,
        amount,
        occurrence_count: 1,
        last_seen: new Date().toISOString(),
        vector
      };
      await this.emailPatterns.add([record]);
    }
  }

  /**
   * Returns email patterns semantically similar to the given text,
   * ordered by vector similarity. Use this to inject known patterns
   * as context into the Gmail Subagent's prompt.
   *
   * @param text  - Query text (e.g. email subject).
   * @param limit - Max results to return (default 10).
   */
  async findSimilarPatterns(text: string, limit = 10): Promise<EmailPatternRecord[]> {
    const vector = await embed(text);
    const results = await this.emailPatterns
      .vectorSearch(vector)
      .limit(limit)
      .toArray();
    return results as EmailPatternRecord[];
  }

  /**
   * Returns all known patterns with ≥ 2 occurrences — the confident recurring ones.
   * Used to build the Gmail Subagent's memory context.
   */
  async getConfirmedPatterns(): Promise<EmailPatternRecord[]> {
    const results = await this.emailPatterns
      .query()
      .where("occurrence_count >= 2")
      .toArray();
    return results as EmailPatternRecord[];
  }

  // ---------------------------------------------------------------------------
  // Task history
  // ---------------------------------------------------------------------------

  /**
   * Persists a task that was successfully created by the Task Manager Subagent.
   *
   * @param suggestion - The original suggestion that was turned into a task.
   * @param runId      - The pipeline run ID this task was created in.
   */
  async storeTask(suggestion: TaskSuggestion, runId: string): Promise<void> {
    const vector = await embed(suggestion.title);
    const record: TaskRecord = {
      id: randomUUID(),
      title: suggestion.title,
      description: suggestion.description ?? "",
      source: suggestion.source,
      run_id: runId,
      created_at: new Date().toISOString(),
      vector
    };
    await this.taskHistory.add([record]);
  }

  /**
   * Checks whether a task with a semantically similar title was created recently.
   * Returns `true` if the cosine similarity with any task in the last 30 days
   * exceeds {@link DUPLICATE_THRESHOLD}.
   *
   * Enables semantic deduplication — catches "Pay AT&T" and "AT&T payment" as the same task.
   *
   * @param title - The proposed task title.
   */
  async isSemanticDuplicate(title: string): Promise<boolean> {
    const vector = await embed(title);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString();

    const recent = await this.taskHistory
      .query()
      .where(`created_at >= '${cutoffStr}'`)
      .toArray() as TaskRecord[];

    for (const task of recent) {
      if (cosineSimilarity(vector, task.vector) >= DUPLICATE_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Run history
  // ---------------------------------------------------------------------------

  /**
   * Persists a summary of one complete pipeline run.
   * Used by the Orchestrator to understand what happened in previous runs.
   *
   * @param runId           - Unique ID for this run.
   * @param suggestionsCount - How many suggestions the Gmail Agent produced.
   * @param tasksCreated    - How many new tasks were created.
   * @param tasksSkipped    - How many suggestions were skipped as duplicates.
   * @param summary         - Claude's plain-text summary for this run.
   */
  async storeRun(
    runId: string,
    suggestionsCount: number,
    tasksCreated: number,
    tasksSkipped: number,
    summary: string
  ): Promise<void> {
    const vector = await embed(summary);
    const record: RunRecord = {
      id: randomUUID(),
      run_id: runId,
      timestamp: new Date().toISOString(),
      suggestions_count: suggestionsCount,
      tasks_created: tasksCreated,
      tasks_skipped: tasksSkipped,
      summary,
      vector
    };
    await this.runHistory.add([record]);
  }

  /**
   * Returns the N most recent pipeline runs, newest first.
   */
  async getRecentRuns(limit = 5): Promise<RunRecord[]> {
    const results = await this.runHistory
      .query()
      .where("timestamp > '2000-01-01'")
      .toArray() as RunRecord[];
    return results
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Context builders — inject memory into agent prompts
  // ---------------------------------------------------------------------------

  /**
   * Builds a memory context string for the Gmail Subagent.
   * Injects confirmed recurring patterns so Claude can recognise them
   * even if they appear slightly differently in new emails.
   *
   * @returns A formatted string ready to append to the Gmail Agent's user message.
   */
  async buildGmailContext(): Promise<string> {
    const patterns = await this.getConfirmedPatterns();
    if (patterns.length === 0) return "";

    const lines = patterns
      .sort((a, b) => b.occurrence_count - a.occurrence_count)
      .map((p) => {
        const amount = p.amount ? ` – ${p.amount}` : "";
        return `  • ${p.sender_domain}${amount} (seen ${p.occurrence_count}x, last: ${p.last_seen.slice(0, 10)})`;
      })
      .join("\n");

    return `\n\n---\nKNOWN RECURRING PATTERNS FROM PREVIOUS RUNS:\n${lines}\nConfirm or update these if you see them in the emails above.\n`;
  }

  /**
   * Builds a memory context string for the Task Manager Subagent.
   * Lists recently created tasks so Claude can perform semantic deduplication
   * beyond what the MCP server's exact-match check provides.
   *
   * @returns A formatted string ready to append to the Task Manager's user message.
   */
  async buildTaskManagerContext(): Promise<string> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString();

    const recent = await this.taskHistory
      .query()
      .where(`created_at >= '${cutoffStr}'`)
      .toArray() as TaskRecord[];

    if (recent.length === 0) return "";

    const lines = recent
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20)
      .map((t) => `  • ${t.title} (created ${t.created_at.slice(0, 10)})`)
      .join("\n");

    return `\n\n---\nTASKS CREATED IN THE LAST 30 DAYS (avoid semantic duplicates):\n${lines}\n`;
  }

  /**
   * Builds a context string summarising recent pipeline runs for the Orchestrator.
   * Helps Claude understand whether the pipeline has run recently and what it found.
   *
   * @returns A formatted string ready to inject into the Orchestrator's system prompt.
   */
  async buildOrchestratorContext(): Promise<string> {
    const runs = await this.getRecentRuns(3);
    if (runs.length === 0) return "";

    const lines = runs.map((r) =>
      `  • ${r.timestamp.slice(0, 10)}: ${r.suggestions_count} suggestions → ${r.tasks_created} created, ${r.tasks_skipped} skipped`
    ).join("\n");

    return `\n\nRECENT RUN HISTORY:\n${lines}`;
  }

  // ---------------------------------------------------------------------------
  // Private seed records (required by LanceDB to infer schema on table creation)
  // ---------------------------------------------------------------------------

  private emptyEmailPattern(): EmailPatternRecord {
    return {
      id: "__seed__",
      text: "",
      sender_domain: "",
      subject_template: "",
      amount: "",
      occurrence_count: 0,
      last_seen: new Date().toISOString(),
      vector: new Array(384).fill(0)
    };
  }

  private emptyTaskRecord(): TaskRecord {
    return {
      id: "__seed__",
      title: "",
      description: "",
      source: "today",
      run_id: "",
      created_at: new Date().toISOString(),
      vector: new Array(384).fill(0)
    };
  }

  private emptyRunRecord(): RunRecord {
    return {
      id: "__seed__",
      run_id: "",
      timestamp: new Date().toISOString(),
      suggestions_count: 0,
      tasks_created: 0,
      tasks_skipped: 0,
      summary: "",
      vector: new Array(384).fill(0)
    };
  }
}
