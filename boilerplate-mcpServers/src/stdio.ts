import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tools } from "./tools/index.js";
import { buildServer, SERVER_NAME } from "./server.js";

// Alternate entrypoint: MCP over stdio, for the classic "the client spawns
// this file as a subprocess" style (e.g. `claude mcp add name -- node
// dist/stdio.js`). The default entrypoint is src/index.ts (Streamable
// HTTP) — use this one when you specifically want a locally-launched
// subprocess instead of a URL to register.

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ready over stdio (${tools.length} tools registered)`);
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
