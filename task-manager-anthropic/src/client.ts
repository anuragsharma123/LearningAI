import Anthropic from "@anthropic-ai/sdk";

/**
 * anthropic — the single shared Anthropic client for the whole application.
 *
 * Replaces LangGraph's `initChatModel("claude-sonnet-4-6")` wrapper.
 * The SDK reads ANTHROPIC_API_KEY from the environment automatically —
 * no need to pass it explicitly. All API calls go through this one instance.
 *
 * LangGraph's initChatModel abstracted away the provider so you could swap
 * "claude-sonnet-4-6" for "gpt-4o" without touching node code. Here we call
 * `anthropic.messages.create()` directly, so the provider is fixed — but
 * you have full control over every parameter on every call.
 */
export const anthropic = new Anthropic();

/**
 * MODEL — used for quality-sensitive generation: compilePlan, refine, getEntertainment.
 * These calls produce long prose or need nuanced reasoning, so Sonnet is worth the cost.
 */
export const MODEL = "claude-sonnet-4-6";

/**
 * FAST_MODEL — used for cheap structured-extraction calls: collectInfo, classifyIntent,
 * saveMemory. These are pure JSON-in / JSON-out tasks where Haiku is ~20× cheaper
 * than Sonnet and just as accurate. Called on every user message, so the saving compounds.
 */
export const FAST_MODEL = "claude-haiku-4-5-20251001";
