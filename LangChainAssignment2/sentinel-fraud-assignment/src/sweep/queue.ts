import { db } from "../db.js";

/** All 276 distinct alerted account ids, oldest alert first. Plain DB read, not an agent tool. */
export function loadQueue(): string[] {
  const rows = db
    .prepare("SELECT account_id, MIN(triggered_at) AS first_triggered FROM alerts GROUP BY account_id ORDER BY first_triggered")
    .all() as unknown as { account_id: string }[];
  return rows.map((r) => r.account_id);
}
