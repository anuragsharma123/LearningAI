import type { TaskSuggestion } from "../task-server/types.js";

/** Fields of a task suggestion that a rule can match against. */
export type MatchField = "title" | "description" | "any";

/** What to do when a rule matches. */
export type FilterAction =
  | "alert_only"   // surface to user, do NOT create a task
  | "drop";        // silently discard — no task, no alert

/** A single user-defined filter rule persisted in rules.json. */
export interface FilterRule {
  id: string;
  name: string;
  /** Substring or keyword to look for (case-insensitive). */
  pattern: string;
  match_field: MatchField;
  action: FilterAction;
  /** Free-text explanation shown in alert messages. */
  reason: string;
  createdAt: string;
}

/** A suggestion that was intercepted by a rule. */
export interface AlertItem {
  suggestion: TaskSuggestion;
  matched_rule: Pick<FilterRule, "id" | "name" | "action" | "reason">;
}

/** The result of running apply_filters over a suggestion list. */
export interface FilterResult {
  passed: TaskSuggestion[];
  alerts: AlertItem[];
  dropped_count: number;
}
