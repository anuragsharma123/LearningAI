import { db } from "../../db.js";

function resolveCustomerId(accountId: string): string | null {
  const row = db.prepare("SELECT customer_id FROM accounts WHERE account_id = ?").get(accountId) as
    | { customer_id: string }
    | undefined;
  return row?.customer_id ?? null;
}

export type SharedDevice = {
  deviceId: string;
  os: string;
  deviceType: string;
  thisCustomerFirstSeen: string;
  thisCustomerLastSeen: string;
  sharedWith: { customerId: string; firstSeen: string; lastSeen: string }[];
};

/**
 * Every device this account's customer has used, and -- for each one -- any
 * OTHER customers who have also used it. An empty sharedWith list means this
 * device is exclusive to this customer.
 */
export function getSharedDevices(accountId: string): SharedDevice[] {
  const customerId = resolveCustomerId(accountId);
  if (!customerId) return [];

  const rows = db
    .prepare(
      "SELECT cd1.device_id, d.os, d.device_type, " +
        "cd1.first_seen AS this_first_seen, cd1.last_seen AS this_last_seen, " +
        "cd2.customer_id AS other_customer_id, cd2.first_seen AS other_first_seen, " +
        "cd2.last_seen AS other_last_seen " +
        "FROM customer_devices cd1 " +
        "JOIN devices d ON d.device_id = cd1.device_id " +
        "LEFT JOIN customer_devices cd2 ON cd2.device_id = cd1.device_id AND cd2.customer_id != cd1.customer_id " +
        "WHERE cd1.customer_id = ? " +
        "ORDER BY cd1.device_id"
    )
    .all(customerId) as unknown as {
    device_id: string;
    os: string;
    device_type: string;
    this_first_seen: string;
    this_last_seen: string;
    other_customer_id: string | null;
    other_first_seen: string | null;
    other_last_seen: string | null;
  }[];

  const byDevice = new Map<string, SharedDevice>();
  for (const r of rows) {
    if (!byDevice.has(r.device_id)) {
      byDevice.set(r.device_id, {
        deviceId: r.device_id,
        os: r.os,
        deviceType: r.device_type,
        thisCustomerFirstSeen: r.this_first_seen,
        thisCustomerLastSeen: r.this_last_seen,
        sharedWith: [],
      });
    }
    if (r.other_customer_id) {
      byDevice.get(r.device_id)!.sharedWith.push({
        customerId: r.other_customer_id,
        firstSeen: r.other_first_seen!,
        lastSeen: r.other_last_seen!,
      });
    }
  }
  return [...byDevice.values()];
}

export type MerchantCoincidence = {
  txnId: string;
  ts: string;
  amount: number;
  merchantId: string;
  merchantName: string;
  category: string;
  riskScore: number;
  coincidentOtherAccounts: number;
};

/**
 * This account's transactions (optionally since sinceTs), each annotated with
 * how many OTHER accounts transacted at the SAME merchant within +/- windowHours
 * of this account's transaction.
 *
 * Deliberately time-windowed rather than lifetime overlap: every merchant
 * naturally accumulates hundreds of distinct customers over 4 months regardless
 * of category, so "other accounts ever used this merchant too" is not a signal
 * -- it's true of almost every merchant. Coordinated TIMING (other accounts
 * hitting the same merchant within a couple of days of this one) is the actual
 * mule-ring shape: money routed through a common recipient in a tight window.
 */
export function getMerchantCoincidence(
  accountId: string,
  sinceTs?: string,
  windowHours = 48
): MerchantCoincidence[] {
  const timeFilter = sinceTs ? "AND t1.ts >= ?" : "";
  const params: (string | number)[] = [windowHours, accountId];
  if (sinceTs) params.push(sinceTs);

  const rows = db
    .prepare(
      "SELECT t1.txn_id, t1.ts, t1.amount, t1.merchant_id, m.name, m.category, m.risk_score, " +
        "COUNT(DISTINCT t2.account_id) AS coincident_other_accounts " +
        "FROM transactions t1 " +
        "JOIN merchants m ON m.merchant_id = t1.merchant_id " +
        "LEFT JOIN transactions t2 ON t2.merchant_id = t1.merchant_id " +
        "AND t2.account_id != t1.account_id " +
        "AND ABS(julianday(t2.ts) - julianday(t1.ts)) * 24 <= ? " +
        "WHERE t1.account_id = ? " +
        timeFilter +
        " GROUP BY t1.txn_id " +
        "ORDER BY coincident_other_accounts DESC, m.risk_score DESC"
    )
    .all(...params) as unknown as {
    txn_id: string;
    ts: string;
    amount: number;
    merchant_id: string;
    name: string;
    category: string;
    risk_score: number;
    coincident_other_accounts: number;
  }[];

  return rows.map((r) => ({
    txnId: r.txn_id,
    ts: r.ts,
    amount: r.amount,
    merchantId: r.merchant_id,
    merchantName: r.name,
    category: r.category,
    riskScore: r.risk_score,
    coincidentOtherAccounts: r.coincident_other_accounts,
  }));
}
