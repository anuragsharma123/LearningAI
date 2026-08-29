import { db } from "../../db.js";

type TxnRow = {
  ts: string;
  amount: number;
  channel: string;
  ip_country: string;
  device_id: string;
  auth_result: string;
};

export type AccountBaseline = {
  accountId: string;
  txnCount: number;
  dateRange: { from: string; to: string } | null;
  amount: { mean: number; median: number; p90: number };
  channelMix: Record<string, number>;
  countryMix: Record<string, number>;
  knownDeviceIds: string[];
  declineRate: number;
  nightTxnFraction: number; // fraction of transactions between 00:00 and 05:59
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function distribution(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  const dist: Record<string, number> = {};
  for (const [k, c] of Object.entries(counts)) dist[k] = c / values.length;
  return dist;
}

/**
 * Computes this account's transaction baseline, optionally excluding
 * everything from `excludeSince` onward (so the flagged window itself
 * doesn't pollute what "normal" looks like).
 */
export function getAccountBaseline(accountId: string, excludeSince?: string): AccountBaseline {
  const rows = (
    excludeSince
      ? db
          .prepare(
            "SELECT ts, amount, channel, ip_country, device_id, auth_result FROM transactions WHERE account_id = ? AND ts < ? ORDER BY ts"
          )
          .all(accountId, excludeSince)
      : db
          .prepare(
            "SELECT ts, amount, channel, ip_country, device_id, auth_result FROM transactions WHERE account_id = ? ORDER BY ts"
          )
          .all(accountId)
  ) as unknown as TxnRow[];

  if (rows.length === 0) {
    return {
      accountId,
      txnCount: 0,
      dateRange: null,
      amount: { mean: 0, median: 0, p90: 0 },
      channelMix: {},
      countryMix: {},
      knownDeviceIds: [],
      declineRate: 0,
      nightTxnFraction: 0,
    };
  }

  const amounts = rows.map((r) => r.amount).sort((a, b) => a - b);
  const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;

  const declineCount = rows.filter((r) => r.auth_result === "declined").length;
  const nightCount = rows.filter((r) => {
    const hour = Number(r.ts.slice(11, 13));
    return hour >= 0 && hour < 6;
  }).length;

  return {
    accountId,
    txnCount: rows.length,
    dateRange: { from: rows[0].ts, to: rows[rows.length - 1].ts },
    amount: {
      mean: Math.round(mean * 100) / 100,
      median: percentile(amounts, 0.5),
      p90: percentile(amounts, 0.9),
    },
    channelMix: distribution(rows.map((r) => r.channel)),
    countryMix: distribution(rows.map((r) => r.ip_country)),
    knownDeviceIds: [...new Set(rows.map((r) => r.device_id))],
    declineRate: Math.round((declineCount / rows.length) * 1000) / 1000,
    nightTxnFraction: Math.round((nightCount / rows.length) * 1000) / 1000,
  };
}

export type TxnDetail = {
  txnId: string;
  cardId: string;
  ts: string;
  amount: number;
  channel: string;
  ipCountry: string;
  deviceId: string;
  authResult: string;
};

/**
 * Raw transaction rows for this account within [fromTs, toTs] — the specific
 * window the LLM actually reads, as opposed to the aggregated baseline.
 * Includes card_id -- not a behavioural signal itself, but it's the account's
 * own transactions table, and Disposition needs a concrete card_id to block a
 * card since it does not read anything itself.
 */
export function getTransactionWindow(accountId: string, fromTs: string, toTs: string): TxnDetail[] {
  const rows = db
    .prepare(
      "SELECT txn_id, card_id, ts, amount, channel, ip_country, device_id, auth_result " +
        "FROM transactions WHERE account_id = ? AND ts >= ? AND ts <= ? ORDER BY ts"
    )
    .all(accountId, fromTs, toTs) as unknown as {
    txn_id: string;
    card_id: string;
    ts: string;
    amount: number;
    channel: string;
    ip_country: string;
    device_id: string;
    auth_result: string;
  }[];

  return rows.map((r) => ({
    txnId: r.txn_id,
    cardId: r.card_id,
    ts: r.ts,
    amount: r.amount,
    channel: r.channel,
    ipCountry: r.ip_country,
    deviceId: r.device_id,
    authResult: r.auth_result,
  }));
}
