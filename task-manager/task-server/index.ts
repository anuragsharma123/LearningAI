import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { Task } from "./types.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_FILE = path.join(__dirname, "tasks.json");

const TaskInputSchema = z.object({
  title: z.string().min(1).describe("Task title"),
  description: z.string().optional().describe("Task description")
});

const TaskIdSchema = z.object({
  taskId: z.string().uuid().describe("Task ID")
});

const TaskUpdateSchema = z.object({
  taskId: z.string().uuid().describe("Task ID"),
  title: z.string().min(1).optional().describe("New title for the task"),
  description: z.string().optional().describe("Updated task description"),
  status: z.enum(["todo", "in-progress", "done"]).optional().describe("Task status")
});

/**
 * Reads all tasks from the JSON file on disk.
 * Returns an empty array if the file does not exist yet (first run).
 * Re-throws any other filesystem error (e.g. permission denied).
 */
async function loadTasks(): Promise<Task[]> {
  try {
    const raw = await fs.readFile(TASK_FILE, "utf8");
    return JSON.parse(raw) as Task[];
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as any).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Writes the full task array to the JSON file, overwriting any previous content.
 * Output is pretty-printed (2-space indent) and ends with a newline.
 *
 * @param tasks - The complete list of tasks to persist.
 */
async function saveTasks(tasks: Task[]): Promise<void> {
  await fs.writeFile(TASK_FILE, JSON.stringify(tasks, null, 2) + "\n", "utf8");
}

/**
 * Formats a single task as a detailed key/value block.
 * Used by the `get_task` tool when the user requests one specific task.
 *
 * Example output:
 * ```
 * Title:       Buy groceries
 * ID:          abc-123
 * Status:      todo
 * Description: Pick up milk and eggs.
 * Created:     2026-05-23T10:00:00.000Z
 * Updated:     2026-05-23T10:00:00.000Z
 * ```
 *
 * @param task - The task to format.
 * @returns A human-readable multi-line detail block for the task.
 */
function formatTask(task: Task): string {
  return [
    `Title:       ${task.title}`,
    `ID:          ${task.id}`,
    `Status:      ${task.status}`,
    `Description: ${task.description ?? "—"}`,
    `Created:     ${task.createdAt}`,
    `Updated:     ${task.updatedAt}`
  ].join("\n");
}

/**
 * Formats an array of tasks as a Unicode box-drawing table with dynamic column widths.
 * Returns a plain "no tasks" message when the array is empty.
 *
 * Columns: #, Title, Description, Status, ID
 *
 * Example output:
 * ```
 * ┌───┬─────────────────┬─────────────┬────────────┬──────────────────────────────────────┐
 * │ # │ Title           │ Description │ Status     │ ID                                   │
 * ├───┼─────────────────┼─────────────┼────────────┼──────────────────────────────────────┤
 * │ 1 │ Buy groceries   │ Milk, eggs  │ todo       │ abc-123...                           │
 * └───┴─────────────────┴─────────────┴────────────┴──────────────────────────────────────┘
 * ```
 *
 * @param tasks - The list of tasks to render.
 * @returns A formatted table string, or an empty-state message.
 */
function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "No tasks are currently saved.";
  }

  const HEADERS = ["#", "Title", "Description", "Status", "ID"];

  const rows = tasks.map((task, i) => [
    String(i + 1),
    task.title,
    task.description ?? "—",
    task.status,
    task.id
  ]);

  // Compute the max width of each column across headers and all rows
  const widths = HEADERS.map((header, col) =>
    Math.max(header.length, ...rows.map((r) => r[col].length))
  );

  const pad = (str: string, width: number): string => str.padEnd(width);
  const divider = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;

  const formatRow = (cells: string[]): string =>
    "│ " + cells.map((c, i) => pad(c, widths[i])).join(" │ ") + " │";

  return [
    divider("┌", "┬", "┐"),
    formatRow(HEADERS),
    divider("├", "┼", "┤"),
    ...rows.map(formatRow),
    divider("└", "┴", "┘")
  ].join("\n");
}

/**
 * Looks up a single task by its UUID.
 * Loads the full task list from disk on every call (no in-memory cache).
 *
 * @param taskId - The UUID of the task to find.
 * @returns The matching {@link Task}, or `undefined` if no task has that ID.
 */
async function findTask(taskId: string): Promise<Task | undefined> {
  const tasks = await loadTasks();
  return tasks.find((task) => task.id === taskId);
}

const mcpServer = new McpServer(
  {
    name: "task-manager-agent",
    version: "1.0.0",
    description: "A local task manager MCP server that stores and manages tasks for Anthropic-powered agents."
  },
  {
    capabilities: {
      logging: {},
      tools: {}
    }
  }
);

/**
 * MCP Tool: create_task
 *
 * Creates a new task with a generated UUID, sets its initial status to "todo",
 * and appends it to the persisted task list.
 *
 * @input title       - Required. The display name of the task (min 1 character).
 * @input description - Optional. Additional detail about the task.
 * @returns A confirmation message containing the task title and new ID.
 */
mcpServer.registerTool(
  "create_task",
  {
    title: "Create Task",
    description: "Create a new task in the task manager.",
    inputSchema: TaskInputSchema
  },
  async ({ title, description }) => {
    const tasks = await loadTasks();
    const task: Task = {
      id: randomUUID(),
      title,
      description,
      status: "todo",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    tasks.push(task);
    await saveTasks(tasks);

    return {
      content: [
        {
          type: "text",
          text: `Task created: ${task.title} (ID: ${task.id})`
        }
      ]
    };
  }
);

/**
 * MCP Tool: list_tasks
 *
 * Returns all tasks currently stored in the JSON file, formatted as a
 * Markdown checkbox list. Returns a plain "no tasks" message when the
 * list is empty. Takes no input parameters.
 */
mcpServer.registerTool(
  "list_tasks",
  {
    title: "List Tasks",
    description: "Return the current list of saved tasks."
  },
  async () => {
    const tasks = await loadTasks();
    return {
      content: [
        {
          type: "text",
          text: formatTaskList(tasks)
        }
      ]
    };
  }
);

/**
 * MCP Tool: get_task
 *
 * Retrieves and formats a single task by its UUID.
 * Throws an error if no task with the given ID exists.
 *
 * @input taskId - The UUID of the task to retrieve.
 * @returns A formatted string showing the task's status, title, ID, and description.
 */
mcpServer.registerTool(
  "get_task",
  {
    title: "Get Task",
    description: "Retrieve a single task by ID.",
    inputSchema: TaskIdSchema
  },
  async ({ taskId }) => {
    const task = await findTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return {
      content: [
        {
          type: "text",
          text: formatTask(task)
        }
      ]
    };
  }
);

/**
 * MCP Tool: update_task
 *
 * Partially updates an existing task. Only the fields provided are changed;
 * omitted fields are left as-is. Always updates `updatedAt` to the current time.
 * Throws an error if no task with the given ID exists.
 *
 * @input taskId      - The UUID of the task to update.
 * @input title       - Optional. New title to replace the existing one.
 * @input description - Optional. New description (pass empty string to clear it).
 * @input status      - Optional. New status: "todo" | "in-progress" | "done".
 * @returns A confirmation message with the updated task title and ID.
 */
mcpServer.registerTool(
  "update_task",
  {
    title: "Update Task",
    description: "Update the title, description, or status of an existing task.",
    inputSchema: TaskUpdateSchema
  },
  async ({ taskId, title, description, status }) => {
    const tasks = await loadTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (title) task.title = title;
    if (description !== undefined) task.description = description;
    if (status) task.status = status;
    task.updatedAt = new Date().toISOString();

    await saveTasks(tasks);

    return {
      content: [
        {
          type: "text",
          text: `Task updated: ${task.title} (ID: ${task.id})`
        }
      ]
    };
  }
);

/**
 * MCP Tool: complete_task
 *
 * Convenience shortcut that sets a task's status to "done" and records
 * the completion time in `updatedAt`. Equivalent to calling update_task
 * with `status: "done"`, but requires only the task ID.
 * Throws an error if no task with the given ID exists.
 *
 * @input taskId - The UUID of the task to mark as done.
 * @returns A confirmation message with the completed task title and ID.
 */
mcpServer.registerTool(
  "complete_task",
  {
    title: "Complete Task",
    description: "Mark a task as done.",
    inputSchema: TaskIdSchema
  },
  async ({ taskId }) => {
    const tasks = await loadTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = "done";
    task.updatedAt = new Date().toISOString();
    await saveTasks(tasks);

    return {
      content: [
        {
          type: "text",
          text: `Task completed: ${task.title} (ID: ${task.id})`
        }
      ]
    };
  }
);

/**
 * MCP Tool: delete_task
 *
 * Permanently removes a task from the persisted list by its UUID.
 * Uses splice so the remaining tasks keep their original order.
 * Throws an error if no task with the given ID exists.
 *
 * @input taskId - The UUID of the task to delete.
 * @returns A confirmation message with the deleted task title and ID.
 */
mcpServer.registerTool(
  "delete_task",
  {
    title: "Delete Task",
    description: "Remove a task from the task manager.",
    inputSchema: TaskIdSchema
  },
  async ({ taskId }) => {
    const tasks = await loadTasks();
    const taskIndex = tasks.findIndex((item) => item.id === taskId);
    if (taskIndex === -1) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const [deleted] = tasks.splice(taskIndex, 1);
    await saveTasks(tasks);

    return {
      content: [
        {
          type: "text",
          text: `Task deleted: ${deleted.title} (ID: ${deleted.id})`
        }
      ]
    };
  }
);

/**
 * Entry point for the MCP server process.
 *
 * Creates a stdio transport (reads from stdin, writes to stdout) and connects
 * the MCP server to it. All registered tools become available to any MCP client
 * that spawns this process. Startup confirmation is written to stderr so it
 * does not interfere with the MCP protocol framing on stdout.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  // Don't log to stdout - it breaks MCP protocol
  // Instead, log to stderr for debugging
  console.error("Task manager MCP server is running on stdio.");
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
