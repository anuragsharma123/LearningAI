import type { ToolDefinition } from "./types.js";
import { echoTool } from "./echo.js";
import { getTimeTool } from "./getTime.js";

// Add new tools here — one import + one entry in this array. Nothing else
// in the server needs to change to pick them up.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tools: ToolDefinition<any>[] = [echoTool, getTimeTool];
