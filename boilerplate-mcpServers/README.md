# MCP Server Boilerplate

A minimal boilerplate for writing [Model Context Protocol](https://modelcontextprotocol.io) servers.

This server only exposes **tools** (plain TypeScript functions). It never calls the
Claude/Anthropic API itself — the LLM side of things is handled entirely by whatever
MCP client connects to it (e.g. Claude Code, Claude Desktop).

```
Your tools (this repo)  <--MCP protocol (stdio)-->  MCP client (e.g. Claude Code)
```

## Setup

```bash
npm install
npm run dev        # run the server directly with tsx, for local iteration
```

## Adding a new tool

1. Create `src/tools/myTool.ts`:

   ```ts
   import { z } from "zod";
   import type { ToolDefinition } from "./types.js";

   export const myTool: ToolDefinition<{ input: ReturnType<typeof z.string> }> = {
     name: "my_tool",
     description: "What this tool does",
     inputSchema: {
       input: z.string().describe("What this argument is"),
     },
     handler: async ({ input }) => {
       return { content: [{ type: "text", text: `You said: ${input}` }] };
     },
   };
   ```

2. Register it in `src/tools/index.ts`:

   ```ts
   import { myTool } from "./myTool.js";

   export const tools = [echoTool, getTimeTool, myTool];
   ```

That's it — no changes needed in `src/index.ts`.

## Debugging without any LLM client

```bash
npm run inspector
```

Opens the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), a web UI for
calling your tools directly and inspecting requests/responses.

## Connecting to Claude Code

From the repo root:

```bash
npm run build --prefix boilerplate-mcpServers
claude mcp add mcp-boilerplate -- node boilerplate-mcpServers/dist/index.js
```

Then restart Claude Code (or run `/mcp` to reconnect) and the tools will show up.

## Scripts

| Script              | Purpose                                   |
| -------------------- | ------------------------------------------ |
| `npm run dev`        | Run the server with `tsx` (no build step)  |
| `npm run build`       | Compile TypeScript to `dist/`              |
| `npm start`           | Run the compiled server                    |
| `npm run typecheck`   | `tsc --noEmit`                             |
| `npm run lint`        | ESLint                                     |
| `npm run inspector`   | Launch MCP Inspector against this server   |

## CI

`.github/workflows/mcp-server-boilerplate-ci.yml` runs install, lint, typecheck, and build on
every push/PR that touches this folder.
