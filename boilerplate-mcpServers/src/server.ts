import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools } from "./tools/index.js";

// Scaffolding (scripts/scaffold.ts) patches this name for a new project —
// keep it as the one place the server's identity is defined, so every
// entrypoint (HTTP, stdio) and their log lines inherit it automatically.
export const SERVER_NAME = "mcp-server-boilerplate";
const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh McpServer with every tool registered. Cheap to call
 * repeatedly — registering a tool is just storing a closure, no I/O — which
 * is what lets src/index.ts build one per HTTP request (see its comment for
 * why that matters).
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      tool.handler
    );
  }

  return server;
}
