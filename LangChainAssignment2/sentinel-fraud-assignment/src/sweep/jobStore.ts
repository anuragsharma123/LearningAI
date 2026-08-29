import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, "..", "..", "output", "jobs");

export type SweepResult = {
  accountId: string;
  verdict: "fraud" | "legitimate" | "insufficient_evidence";
  confidence: "high" | "medium" | "low";
  recommendedAction: "block_card" | "escalate_case" | "none";
};

export type SweepError = {
  accountId: string;
  error: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCalls: number;
};

export type Job = {
  jobId: string;
  status: "running" | "completed" | "failed" | "stopped";
  total: number;
  completed: number;
  startedAt: string;
  finishedAt?: string;
  results: SweepResult[];
  errors: SweepError[];
  tokenUsage?: TokenUsage;
};

function jobPath(jobId: string): string {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

export function createJob(jobId: string, total: number): Job {
  const job: Job = {
    jobId,
    status: "running",
    total,
    completed: 0,
    startedAt: new Date().toISOString(),
    results: [],
    errors: [],
  };
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(jobPath(jobId), JSON.stringify(job, null, 2));
  return job;
}

export function readJob(jobId: string): Job | null {
  const p = jobPath(jobId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function writeJob(job: Job): void {
  fs.writeFileSync(jobPath(job.jobId), JSON.stringify(job, null, 2));
}

export function appendResult(jobId: string, result: SweepResult): void {
  const job = readJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  job.results.push(result);
  job.completed += 1;
  writeJob(job);
}

export function appendError(jobId: string, error: SweepError): void {
  const job = readJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  job.errors.push(error);
  job.completed += 1;
  writeJob(job);
}

export function finishJob(jobId: string, tokenUsage?: TokenUsage): void {
  const job = readJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  job.tokenUsage = tokenUsage;
  writeJob(job);
}
