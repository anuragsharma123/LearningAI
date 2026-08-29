import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "..", "output");
const DISPOSITIONS_PATH = path.join(OUTPUT_DIR, "dispositions.json");
const ACTIONS_PATH = path.join(OUTPUT_DIR, "actions.json");

function readJson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function appendJson<T>(filePath: string, entry: T): void {
  const entries = readJson<T>(filePath);
  entries.push(entry);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

export type Verdict = "fraud" | "legitimate" | "insufficient_evidence";
export type Confidence = "high" | "medium" | "low";

export type DispositionRecord = {
  accountId: string;
  verdict: Verdict;
  confidence: Confidence;
  reasoning: string;
  recordedAt: string;
};

/**
 * Records the final verdict on this account. This is documentation, not an
 * irreversible action -- it never touches sentinel.db, only our own output
 * store, and does not require human approval.
 */
export function recordDisposition(input: Omit<DispositionRecord, "recordedAt">): DispositionRecord {
  const record: DispositionRecord = { ...input, recordedAt: new Date().toISOString() };
  appendJson(DISPOSITIONS_PATH, record);
  return record;
}

export function listDispositions(): DispositionRecord[] {
  return readJson<DispositionRecord>(DISPOSITIONS_PATH);
}

export type ActionRecord = {
  accountId: string;
  action: "block_card" | "escalate_case";
  detail: Record<string, unknown>;
  reason: string;
  executedAt: string;
};

/**
 * Blocks a card. IRREVERSIBLE -- this must only ever be called after human
 * approval via the humanInTheLoopMiddleware gate on this tool; the function
 * itself does not know or enforce that, the agent wiring does.
 */
export function blockCard(input: { accountId: string; cardId: string; reason: string }): ActionRecord {
  const record: ActionRecord = {
    accountId: input.accountId,
    action: "block_card",
    detail: { cardId: input.cardId },
    reason: input.reason,
    executedAt: new Date().toISOString(),
  };
  appendJson(ACTIONS_PATH, record);
  return record;
}

/**
 * Escalates a case for further human investigation. IRREVERSIBLE in the sense
 * that it commits investigator time and alerts a person -- also gated by
 * human approval.
 */
export function escalateCase(input: { accountId: string; reason: string }): ActionRecord {
  const record: ActionRecord = {
    accountId: input.accountId,
    action: "escalate_case",
    detail: {},
    reason: input.reason,
    executedAt: new Date().toISOString(),
  };
  appendJson(ACTIONS_PATH, record);
  return record;
}

export function listActions(): ActionRecord[] {
  return readJson<ActionRecord>(ACTIONS_PATH);
}
