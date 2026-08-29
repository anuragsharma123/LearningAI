import { db } from "../db.js";

type AlertRow = {
  alert_id: string;
  rule_id: string;
  name: string;
  description: string;
  triggered_at: string;
  severity: string;
  trigger_txn_id: string;
};

/**
 * Deterministic lookup, no LLM involved: every open alert for this account,
 * joined with the rule that fired it. This is plain application code, not a
 * tool the supervisor calls -- the supervisor holds zero database access, but
 * something has to tell it which alert(s) it's triaging before it can start
 * routing to specialists. Run once via beforeAgent, before the supervisor's
 * own reasoning starts.
 */
export function loadAlertContext(accountId: string): string {
  const rows = db
    .prepare(
      "SELECT a.alert_id, a.rule_id, r.name, r.description, a.triggered_at, a.severity, a.trigger_txn_id " +
        "FROM alerts a JOIN rules r ON r.rule_id = a.rule_id " +
        "WHERE a.account_id = ? ORDER BY a.triggered_at"
    )
    .all(accountId) as unknown as AlertRow[];

  if (rows.length === 0) {
    return `Account ${accountId} has no open alerts on file.`;
  }

  const lines = rows.map(
    (r) =>
      `- ${r.alert_id}: rule ${r.rule_id} "${r.name}" (${r.description}), triggered ${r.triggered_at}, ` +
      `severity ${r.severity}, trigger transaction ${r.trigger_txn_id}`
  );

  return `Account ${accountId} has ${rows.length} open alert(s):\n${lines.join("\n")}`;
}
