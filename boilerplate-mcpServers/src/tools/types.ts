import type { ZodRawShape, z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  /**
   * MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint,
   * openWorldHint). These are hints a client MAY use — e.g. an MCP registry
   * deciding whether a call needs human approval before it runs — but per
   * the MCP spec they are never a substitute for the caller's own
   * authorization checks. Set them honestly for every tool you add.
   */
  annotations?: ToolAnnotations;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

// Infers the input/output types from `inputSchema` so tool files don't need
// to hand-write generic type arguments (which drift when using .default(),
// .optional(), etc).
export function defineTool<Shape extends ZodRawShape>(
  tool: ToolDefinition<Shape>
): ToolDefinition<Shape> {
  return tool;
}
