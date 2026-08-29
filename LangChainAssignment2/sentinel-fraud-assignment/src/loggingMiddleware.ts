import { createMiddleware } from "langchain";
import { log } from "./log.js";

function oneLine(value: unknown, maxLen: number): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat;
}

/** Logs one compact line per tool call: name, args, and a short result preview. */
export function toolLoggingMiddleware(specialistName: string) {
  return createMiddleware({
    name: `${specialistName}ToolLogger`,
    wrapToolCall: async (request, handler) => {
      const args = oneLine(request.toolCall.args, 40);
      const result = await handler(request);
      const content = "content" in result ? result.content : "";
      const preview = oneLine(content, 50);
      log(specialistName, `${request.toolCall.name}(${args}) -> ${preview}`);
      return result;
    },
  });
}
