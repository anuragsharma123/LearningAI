import { db } from "../../db.js";

function resolveCustomerId(accountId: string): string | null {
  const row = db.prepare("SELECT customer_id FROM accounts WHERE account_id = ?").get(accountId) as
    | { customer_id: string }
    | undefined;
  return row?.customer_id ?? null;
}

export type CaseNote = {
  noteId: string;
  createdAt: string;
  author: string;
  channel: string;
  note: string;
};

/**
 * Raw case notes for this account's customer, oldest first. Deliberately returns
 * full note text, unsummarized -- this is the free text a specialist has to read,
 * not aggregate.
 */
export function getCaseNotes(accountId: string): CaseNote[] {
  const customerId = resolveCustomerId(accountId);
  if (!customerId) return [];

  const rows = db
    .prepare(
      "SELECT note_id, created_at, author, channel, note FROM case_notes " +
        "WHERE customer_id = ? ORDER BY created_at"
    )
    .all(customerId) as unknown as {
    note_id: string;
    created_at: string;
    author: string;
    channel: string;
    note: string;
  }[];

  return rows.map((r) => ({
    noteId: r.note_id,
    createdAt: r.created_at,
    author: r.author,
    channel: r.channel,
    note: r.note,
  }));
}

export type Dispute = {
  disputeId: string;
  txnId: string;
  filedAt: string;
  reasonCode: string;
  customerStatement: string;
  status: string;
};

/**
 * Disputes filed against this specific account's transactions. Disputes are keyed
 * to a txn_id, so this joins through transactions rather than customer_id.
 */
export function getDisputes(accountId: string): Dispute[] {
  const rows = db
    .prepare(
      "SELECT d.dispute_id, d.txn_id, d.filed_at, d.reason_code, d.customer_statement, d.status " +
        "FROM disputes d JOIN transactions t ON t.txn_id = d.txn_id " +
        "WHERE t.account_id = ? ORDER BY d.filed_at"
    )
    .all(accountId) as unknown as {
    dispute_id: string;
    txn_id: string;
    filed_at: string;
    reason_code: string;
    customer_statement: string;
    status: string;
  }[];

  return rows.map((r) => ({
    disputeId: r.dispute_id,
    txnId: r.txn_id,
    filedAt: r.filed_at,
    reasonCode: r.reason_code,
    customerStatement: r.customer_statement,
    status: r.status,
  }));
}

export type PriorCase = {
  caseId: string;
  openedDate: string;
  closedDate: string | null;
  outcome: string;
  summary: string;
};

/**
 * Prior investigations opened on this account's customer, most recent first --
 * a customer with three prior false positives is a different read than one with
 * a confirmed compromise last year.
 */
export function getPriorCases(accountId: string): PriorCase[] {
  const customerId = resolveCustomerId(accountId);
  if (!customerId) return [];

  const rows = db
    .prepare(
      "SELECT case_id, opened_date, closed_date, outcome, summary FROM prior_cases " +
        "WHERE customer_id = ? ORDER BY opened_date DESC"
    )
    .all(customerId) as unknown as {
    case_id: string;
    opened_date: string;
    closed_date: string | null;
    outcome: string;
    summary: string;
  }[];

  return rows.map((r) => ({
    caseId: r.case_id,
    openedDate: r.opened_date,
    closedDate: r.closed_date,
    outcome: r.outcome,
    summary: r.summary,
  }));
}
