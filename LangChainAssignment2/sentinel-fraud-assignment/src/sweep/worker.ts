import { triageCase } from "../supervisor/agent.js";
import { loadQueue } from "./queue.js";
import { appendResult, appendError, finishJob } from "./jobStore.js";
import { getTokenUsage, resetTokenUsage } from "../tokenTracker.js";

const CONCURRENCY = 6;

async function processAccount(jobId: string, accountId: string): Promise<void> {
  try {
    // Each triageCase() call is a fresh agent invocation with its own message
    // history -- one account's context never leaks into another's.
    const result = await triageCase(accountId);
    appendResult(jobId, {
      accountId,
      verdict: result.verdict,
      confidence: result.confidence,
      recommendedAction: result.recommendedAction,
    });
  } catch (err) {
    appendError(jobId, { accountId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Runs `worker(item)` over `items` with at most `concurrency` in flight at once. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
}

async function main() {
  const jobId = process.argv[2];
  const limitArg = process.argv[3];
  if (!jobId) {
    console.error("Usage: worker.ts <jobId> [limit]");
    process.exit(1);
  }

  resetTokenUsage();

  const limit = limitArg ? Number(limitArg) : undefined;
  const queue = limit ? loadQueue().slice(0, limit) : loadQueue();

  await runPool(queue, CONCURRENCY, (accountId) => processAccount(jobId, accountId));

  finishJob(jobId, getTokenUsage());
}

main();
