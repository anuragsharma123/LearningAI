import type { ZodRawShape, z } from "zod";

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
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
