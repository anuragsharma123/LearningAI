import { initChatModel } from "langchain";

/**
 * `initChatModel` is a LangChain helper that wraps any LLM provider (Anthropic, OpenAI, etc.)
 * behind a common interface. Swapping "claude-sonnet-4-6" for another model ID changes the
 * underlying provider without touching any node code.
 *
 * Two separate instances are intentional — they differ only in streaming and temperature:
 */

/**
 * Primary model used for text generation nodes (compilePlan, entertainment, refinement).
 * - streaming: true  → tokens are emitted as they arrive, required by Anthropic when
 *                       maxTokens is very large (25k). Without it the request times out.
 * - temperature 0.3  → slight creativity for natural-sounding plan prose.
 * - timeout 300s     → long plans can take 30-60s; 300s is a safe ceiling.
 */
export const model = await initChatModel("claude-sonnet-4-6", {
    temperature: 0.3,
    timeout: 300,
    maxTokens: 7_000,
    streaming: true,
});

/**
 * Dedicated model for structured-output calls (withStructuredOutput / Zod schema extraction).
 * - streaming: false → LangChain's withStructuredOutput accumulates the full JSON string
 *                      before parsing it. If streaming is on, chunks arrive out-of-order
 *                      and JSON parsing fails mid-stream.
 * - temperature 0    → deterministic extraction; we want the same field values every time.
 * - maxTokens 2000   → extraction responses are short JSON objects, no need for 25k tokens.
 * - timeout 60s      → short tasks should finish fast; fail loudly if they don't.
 */
export const extractionModel = await initChatModel("claude-haiku-4-5-20251001", {
    temperature: 0,
    timeout: 60,
    maxTokens: 2_000,
    streaming: false,
});
