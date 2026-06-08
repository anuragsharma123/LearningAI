/**
 * API Server — HTTP REST + WebSocket for the task manager UI.
 *
 * REST endpoints (all require Authorization: Bearer <API_KEY>):
 *   GET    /tasks          — list all tasks
 *   GET    /tasks/:id      — get one task
 *   PATCH  /tasks/:id/status — update status (todo | in-progress | done)
 *   DELETE /tasks/:id      — delete a task
 *
 * Internal webhook (same auth, called by orchestrator):
 *   POST   /internal/events — broadcast event to all WebSocket clients
 *
 * WebSocket (token validated at upgrade handshake):
 *   ws://host:PORT?token=<API_KEY>
 *   Receives broadcast events:
 *     { type: "filter_alert", suggestion, matched_rule }
 *     { type: "task_created", title, description }
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";

import type { Task, TaskStatus } from "../task-server/types.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = path.join(__dirname, "../task-server/tasks.json");
const PORT       = Number(process.env.API_PORT ?? 3001);

// ---------------------------------------------------------------------------
// API key — read from env or generate and print a one-time key
// ---------------------------------------------------------------------------

let API_KEY = process.env.API_KEY ?? "";
if (!API_KEY) {
  API_KEY = randomBytes(24).toString("hex");
  console.warn(`\n⚠  No API_KEY in .env. Generated for this session:\n   API_KEY=${API_KEY}\n`);
}

// ---------------------------------------------------------------------------
// Task persistence helpers (read-only from this server's perspective for creates)
// ---------------------------------------------------------------------------

async function loadTasks(): Promise<Task[]> {
  try {
    const raw = await fs.readFile(TASKS_FILE, "utf8");
    return JSON.parse(raw) as Task[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function saveTasks(tasks: Task[]): Promise<void> {
  await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authenticate(req: http.IncomingMessage): boolean {
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${API_KEY}`;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

function broadcast(payload: Record<string, unknown>): void {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetTasks(res: http.ServerResponse): Promise<void> {
  const tasks = await loadTasks();
  send(res, 200, tasks);
}

async function handleGetTask(res: http.ServerResponse, id: string): Promise<void> {
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return send(res, 404, { error: "Task not found" });
  send(res, 200, task);
}

async function handlePatchStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  let body: { status?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "Invalid JSON body" });
  }

  const VALID: TaskStatus[] = ["todo", "in-progress", "done"];
  const newStatus = body.status as TaskStatus;
  if (!VALID.includes(newStatus)) {
    return send(res, 400, { error: `status must be one of: ${VALID.join(", ")}` });
  }

  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return send(res, 404, { error: "Task not found" });
  if (task.status === "done") {
    return send(res, 409, { error: "Cannot update a completed task" });
  }

  task.status = newStatus;
  task.updatedAt = new Date().toISOString();
  await saveTasks(tasks);
  send(res, 200, task);
}

async function handleDeleteTask(res: http.ServerResponse, id: string): Promise<void> {
  const tasks = await loadTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return send(res, 404, { error: "Task not found" });
  const [deleted] = tasks.splice(idx, 1);
  await saveTasks(tasks);
  send(res, 200, { deleted: deleted.id });
}

async function handleInternalEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "Invalid JSON body" });
  }
  broadcast(payload);
  send(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// HTTP request router
// ---------------------------------------------------------------------------

const TASK_ID_RE    = /^\/tasks\/([^/]+)$/;
const STATUS_RE     = /^\/tasks\/([^/]+)\/status$/;

async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url    = req.url ?? "/";

  // Internal webhook — same auth
  if (method === "POST" && url === "/internal/events") {
    if (!authenticate(req)) return send(res, 401, { error: "Unauthorized" });
    return handleInternalEvent(req, res);
  }

  // All other routes require auth
  if (!authenticate(req)) return send(res, 401, { error: "Unauthorized" });

  // GET /tasks
  if (method === "GET" && url === "/tasks") return handleGetTasks(res);

  // GET /tasks/:id
  const idMatch = TASK_ID_RE.exec(url);
  if (method === "GET" && idMatch) return handleGetTask(res, idMatch[1]);

  // PATCH /tasks/:id/status
  const statusMatch = STATUS_RE.exec(url);
  if (method === "PATCH" && statusMatch) return handlePatchStatus(req, res, statusMatch[1]);

  // DELETE /tasks/:id
  if (method === "DELETE" && idMatch) return handleDeleteTask(res, idMatch[1]);

  send(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server setup
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  router(req, res).catch((err) => {
    console.error("Request error:", err);
    send(res, 500, { error: "Internal server error" });
  });
});

// Validate WebSocket token at the upgrade handshake
httpServer.on("upgrade", (req, socket, head) => {
  const token = new URL(req.url ?? "", `http://localhost`).searchParams.get("token");
  if (token !== API_KEY) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

httpServer.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  console.log(`WebSocket  listening on ws://localhost:${PORT}?token=<API_KEY>`);
});
