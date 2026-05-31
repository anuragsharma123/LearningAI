import Anthropic from "@anthropic-ai/sdk";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";
import * as readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Anthropic SDK instance used for all Claude API calls. */
const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Agent persona and behavioural instructions loaded from `system-prompt.md`.
 * Read once at startup so edits to the file take effect on the next run
 * without touching any TypeScript code.
 */
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "system-prompt.md"),
  "utf8"
);

/** Singleton MCP client connected to the spawned server process. */
let mcpClient: Client;

/**
 * Persistent conversation history for the current process lifetime.
 * Accumulates every user message, assistant reply, and tool-result turn so
 * Claude has full context across multiple prompts in the same session.
 */
const conversationHistory: Anthropic.MessageParam[] = [];


/**
 * Spawns the MCP server as a child process and connects to it over stdio.
 * Uses `tsx` to run `task-server/index.ts` directly without a build step.
 * The current process environment (minus `undefined` values) is forwarded
 * to the child so it inherits `ANTHROPIC_API_KEY` and any other env vars.
 *
 * Populates the module-level `mcpClient` singleton on success.
 * Throws if the connection cannot be established.
 */
async function initializeMcpServer(): Promise<void> {
  console.log("Starting MCP server...");

  // Create transport that spawns the server
  const transport = new StdioClientTransport({
    command: "tsx",
    args: [path.join(__dirname, "task-server/index.ts")],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
  });

  // Create MCP client
  mcpClient = new Client(
    {
      name: "task-manager-client",
      version: "1.0.0"
    },
    {
      capabilities: {}
    }
  );

  // Connect to server
  try {
    await mcpClient.connect(transport);
    console.log("✓ Connected to MCP server\n");
  } catch (error) {
    throw error;
  }
}

/**
 * Queries the MCP server for its registered tools and converts them into the
 * format expected by the Anthropic SDK (`name`, `description`, `input_schema`).
 *
 * Called once after the server connects; the returned array is reused for
 * every subsequent Claude API call so the model always knows which tools exist.
 *
 * @returns An array of Anthropic-compatible tool definitions.
 * @throws If the MCP `listTools` request fails.
 */
async function getAvailableTools(): Promise<Anthropic.Tool[]> {
  try {
    // Get tool list from MCP server
    const response = await mcpClient.listTools();
    
    const tools: Anthropic.Tool[] = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool["input_schema"]
    }));

    return tools;
  } catch (error) {
    console.error("Failed to get tools from MCP server:", error);
    throw error;
  }
}

/**
 * Executes a single MCP tool by name and returns its text output.
 *
 * Sends a `tools/call` request to the MCP server with the provided arguments,
 * then extracts the first `text` content block from the response.
 * Falls back to a generic success message if no text block is present.
 *
 * @param toolName  - The registered name of the tool to invoke (e.g. `"create_task"`).
 * @param toolInput - Key/value arguments matching the tool's input schema.
 * @returns The text result returned by the tool.
 * @throws If the MCP server returns an error for the tool call.
 */
async function callMcpTool(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
  try {
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: toolInput
    });

    // Extract text from result
    const content = result.content as Array<{ type: string; text?: string }>;
    if (content && content.length > 0) {
      const textContent = content.find((c) => c.type === "text");
      if (textContent?.text) {
        return textContent.text;
      }
    }

    return "Tool executed successfully";
  } catch (error) {
    throw new Error(`Tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sends a user message to Claude and drives the full agentic loop until the
 * model produces a final text response.
 *
 * Flow:
 * 1. Appends the user message to `conversationHistory`.
 * 2. Calls the Claude API with the system prompt, tool definitions, and full history.
 * 3. While Claude responds with `stop_reason === "tool_use"`:
 *    a. Saves the assistant's tool-call turn to history.
 *    b. Executes each requested tool via the MCP server.
 *    c. Appends all tool results to history and calls Claude again.
 * 4. Saves the final assistant reply to history and prints it to stdout.
 *
 * Tool errors are caught per-tool and fed back to Claude as error content so
 * the model can react (e.g. report the failure or try an alternative).
 *
 * @param userMessage - The raw text typed by the user.
 * @param tools       - Anthropic-compatible tool definitions from {@link getAvailableTools}.
 */
async function chat(userMessage: string, tools: Anthropic.Tool[]): Promise<void> {
  console.log(`\nUser: ${userMessage}\n`);

  conversationHistory.push({ role: "user", content: userMessage });

  let response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
    messages: conversationHistory
  });

  // Agentic loop: continue until the model stops calling tools
  while (response.stop_reason === "tool_use") {
    conversationHistory.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        try {
          console.log(`[MCP] Calling tool: ${block.name}`);
          console.log(`[MCP] Input:`, JSON.stringify(block.input, null, 2));

          const result = await callMcpTool(block.name, block.input as Record<string, unknown>);

          console.log(`[MCP] Result: ${result}\n`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result
          });
        } catch (error) {
          console.error(`[MCP] Error:`, error instanceof Error ? error.message : String(error));
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    conversationHistory.push({ role: "user", content: toolResults });

    response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages: conversationHistory
    });
  }

  // Save final assistant reply to history and print it
  conversationHistory.push({ role: "assistant", content: response.content });

  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`Assistant: ${block.text}\n`);
    }
  }
}

/**
 * Entry point for the task manager client.
 *
 * Start-up sequence:
 * 1. Spawns and connects to the MCP server ({@link initializeMcpServer}).
 * 2. Fetches the available tool definitions ({@link getAvailableTools}).
 * 3. Opens a readline REPL that passes each user prompt to {@link chat}.
 *
 * Typing `exit` (case-insensitive) closes the readline interface, disconnects
 * the MCP client gracefully, and exits the process with code 0.
 * Any unhandled start-up error is printed to stderr and exits with code 1.
 */
async function main(): Promise<void> {
  try {
    await initializeMcpServer();
    
    // Get available tools from MCP server
    const tools = await getAvailableTools();
    console.log(`Loaded ${tools.length} tools from MCP server.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log("Task Manager Agent - Type 'exit' to quit\n");

    const askQuestion = (): void => {
      rl.question("You: ", async (input) => {
        if (input.toLowerCase() === "exit") {
          rl.close();
          await mcpClient.close();
          process.exit(0);
        }

        try {
          await chat(input, tools);
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : String(error));
        }

        askQuestion();
      });
    };

    askQuestion();
  } catch (error) {
    console.error("Failed to start client:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
