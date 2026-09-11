import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { tools } from "./tools/index.js";
import { buildServer, SERVER_NAME } from "./server.js";

// Default entrypoint: MCP over Streamable HTTP. This gives the server one
// URL (http://localhost:PORT/mcp) that can be registered anywhere an MCP
// server address is expected — a registry, `claude mcp add --transport
// http`, the MCP Inspector — with no subprocess to launch. For the classic
// "Claude Code spawns this as a subprocess over stdio" style instead, see
// src/stdio.ts (`npm run dev:stdio`).

const app = express();
app.use(express.json());

// Stateless Streamable HTTP (sessionIdGenerator: undefined) — no per-client
// session is tracked, since a tool call here is expected to be a
// self-contained request/response. A fresh McpServer + transport pair is
// built for EVERY request rather than one shared pair reused across
// requests: that's cheap (registering a tool is just storing a closure, no
// I/O) and it matters for a real reason — reusing one transport instance
// across requests was found to corrupt state in the SDK's Node/SSE compat
// layer starting on the second request. Per-request instances sidestep it
// entirely and are the more robust pattern for a stateless endpoint anyway.
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Stateless mode has no session to resume or close, but some clients probe
// GET/DELETE anyway — answer with a clear "not supported" instead of hanging.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// No auth — just confirms the process is up and what it's serving. Useful
// for container/platform health checks.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", tools: tools.map((t) => t.name) });
});

const httpServer = app.listen(config.PORT, () => {
  console.error(`${SERVER_NAME} listening on http://localhost:${config.PORT}/mcp`);
  console.error(`health check:      http://localhost:${config.PORT}/healthz`);
  console.error(`tools registered:  ${tools.length}`);
});

httpServer.on("error", (error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
