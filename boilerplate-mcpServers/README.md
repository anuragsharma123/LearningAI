# MCP Server Boilerplate

A minimal boilerplate for writing [Model Context Protocol](https://modelcontextprotocol.io) servers.

This server only exposes **tools** (plain TypeScript functions). It never calls the
Claude/Anthropic API itself — the LLM side of things is handled entirely by whatever
MCP client connects to it.

```
Your tools (this repo)  <--MCP protocol (Streamable HTTP)-->  MCP client / registry
```

It ships two entrypoints that share the same tool registrations
(`src/server.ts`):

| Entrypoint | Transport | When to use it |
|---|---|---|
| `src/index.ts` (default) | Streamable HTTP | you want **one URL** to register — an MCP registry, a remote client, `claude mcp add --transport http` |
| `src/stdio.ts` | stdio | you want the client to **launch this as a subprocess** itself (the classic `claude mcp add name -- node dist/stdio.js` shape) |

Most of the time you want the default — a running server with an address is
the more general, more deployable shape, and it's what "register this as an
MCP server" almost always means outside of a local Claude Code subprocess.

## Setup

```bash
cp .env.example .env
npm install
npm run dev        # HTTP, tsx, no build step — for local iteration
```

The server listens on `http://localhost:$PORT/mcp` (default port `3333`).
`GET /healthz` gives a no-auth status check (`{ status, tools }`) — useful
to confirm it's up before wiring it into anything.

Sanity-check without any MCP client:

```bash
curl http://localhost:3333/healthz

curl -s -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
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
     annotations: {
       readOnlyHint: true, // false if it writes/modifies anything; add destructiveHint: true if it's irreversible
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

That's it — no changes needed in `src/index.ts` or `src/stdio.ts`. Set
`annotations` honestly: a client or registry may use `readOnlyHint` /
`destructiveHint` to decide whether a call needs human approval before it
runs.

Need config beyond a plain string arg (an API token, a base URL)? Add it to
the `EnvSchema` in `src/config.ts` — it fails fast at startup with a clear
message if something required is missing, rather than failing obscurely
inside a tool call later.

## Debugging without any LLM client

```bash
npm run dev            # start the server in one terminal
npm run inspector       # in another — opens the MCP Inspector web UI
```

In the Inspector, choose **Streamable HTTP** as the transport and paste
`http://localhost:3333/mcp`.

For the stdio entrypoint instead: `npm run inspector:stdio` launches the
Inspector already pointed at `src/stdio.ts`, no separate server process
needed.

## Connecting to Claude Code

**HTTP (default) — register the URL, run the server yourself:**

```bash
npm run build
npm start
# in another terminal:
claude mcp add --transport http mcp-boilerplate http://localhost:3333/mcp
```

**stdio — let Claude Code launch it as a subprocess:**

```bash
npm run build
claude mcp add mcp-boilerplate -- node dist/stdio.js
```

Then restart Claude Code (or run `/mcp` to reconnect) and the tools will show up.

## Scripts

| Script                | Purpose                                          |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Run the HTTP server with `tsx` (no build step)    |
| `npm run dev:stdio`     | Run the stdio server with `tsx`                   |
| `npm run build`         | Compile TypeScript to `dist/`                      |
| `npm start`             | Run the compiled HTTP server                       |
| `npm run start:stdio`    | Run the compiled stdio server                      |
| `npm run typecheck`      | `tsc --noEmit`                                     |
| `npm run lint`           | ESLint                                             |
| `npm run inspector`       | Launch MCP Inspector (point it at the HTTP URL)     |
| `npm run inspector:stdio` | Launch MCP Inspector against the stdio entrypoint   |
| `npm run scaffold`        | Copy this boilerplate into another project's subfolder |

## Scaffolding a new server from this one

```bash
npm run scaffold
```

Prompts for a target project path, a subfolder name, and a new git branch
name; copies `src/`, config files, and a patched `package.json` +
`README.md` into `<target>/<subfolder>`, then runs `npm install` there. The
new server's identity (`SERVER_NAME` in `src/server.ts`) is renamed
automatically — every log line and the `McpServer` itself pick it up.

## CI

`.github/workflows/mcp-server-boilerplate-ci.yml` runs install, lint, typecheck, and build on
every push/PR that touches this folder.
