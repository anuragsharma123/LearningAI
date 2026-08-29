import { createMiddleware } from "langchain";
import { z } from "zod";
import { loadAlertContext } from "./alertContext.js";

/**
 * Runs once, before the supervisor's own reasoning starts. Plain deterministic
 * lookup (see alertContext.ts) -- not a tool call, not an LLM decision, so it
 * does not count as "the supervisor querying the database."
 *
 * Stores the result in middleware state and merges it into the system prompt
 * on every model call, rather than injecting it as a message -- Anthropic only
 * allows a system-role message as the very first message, which a beforeAgent
 * injection after the initial human message would violate.
 */
export const alertContextMiddleware = createMiddleware({
  name: "AlertContextLoader",
  stateSchema: z.object({
    alertContext: z.string().default(""),
  }),
  contextSchema: z.object({
    accountId: z.string(),
  }),
  beforeAgent: async (_state, runtime) => {
    return { alertContext: loadAlertContext(runtime.context.accountId) };
  },
  wrapModelCall: async (request, handler) => {
    return handler({
      ...request,
      systemMessage: request.systemMessage.concat(`\n\nAlert context:\n${request.state.alertContext}`),
    });
  },
});
