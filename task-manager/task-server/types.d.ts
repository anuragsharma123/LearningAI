/** Valid lifecycle states for a task. */
export type TaskStatus = "todo" | "in-progress" | "done";

/** Shape of a persisted task record. */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

/** A task suggestion produced by the Gmail Agent and consumed by the Task Manager Agent. */
export interface TaskSuggestion {
  title: string;
  description?: string;
  /** Whether the task came from today's inbox or a recurring pattern. */
  source: "today" | "recurring";
}
