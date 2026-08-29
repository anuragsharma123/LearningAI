import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, readJob } from "./jobStore.js";
import { loadQueue } from "./queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const WORKER_PATH = path.join(__dirname, "worker.ts");

/**
 * Starts a sweep of the alert queue (or the first `limit` accounts, for testing)
 * and returns a job id immediately. The actual work happens in a detached child
 * process, so this returns in milliseconds regardless of queue size -- the
 * caller is never blocked waiting for 276 accounts to be triaged.
 */
export function startSweep(limit?: number): { jobId: string; total: number } {
  const total = limit ?? loadQueue().length;
  const jobId = `sweep-${Date.now()}`;
  createJob(jobId, total);

  const args = ["tsx", "--env-file=.env", WORKER_PATH, jobId, ...(limit ? [String(limit)] : [])];
  const child = spawn("npx", args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return { jobId, total };
}

/** Progress only -- how many of `total` have been triaged so far. */
export function getSweepStatus(jobId: string) {
  const job = readJob(jobId);
  if (!job) return { found: false as const };
  return {
    found: true as const,
    status: job.status,
    total: job.total,
    completed: job.completed,
    errorCount: job.errors.length,
  };
}

/** Full results. Only meaningful once status is "completed"; returns what's done so far otherwise. */
export function getSweepResults(jobId: string) {
  const job = readJob(jobId);
  if (!job) return { found: false as const };
  return {
    found: true as const,
    status: job.status,
    results: job.results,
    errors: job.errors,
  };
}
