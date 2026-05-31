/**
 * Type definitions for records stored in the LanceDB vector tables.
 * Each record includes a `vector` field populated by the embedding model.
 */

/** A recurring email pattern detected across multiple runs. */
export interface EmailPatternRecord {
  id: string;
  /** e.g. "at&t internet bill" */
  text: string;
  sender_domain: string;
  subject_template: string;
  amount: string;
  occurrence_count: number;
  last_seen: string;
  vector: number[];
}

/** A task that was created by the Task Manager Subagent. */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  source: string;
  run_id: string;
  created_at: string;
  vector: number[];
}

/** A summary of one full orchestrator pipeline run. */
export interface RunRecord {
  id: string;
  run_id: string;
  timestamp: string;
  suggestions_count: number;
  tasks_created: number;
  tasks_skipped: number;
  summary: string;
  vector: number[];
}
