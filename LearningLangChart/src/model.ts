import { initChatModel } from "langchain";

// Streaming model for long operations — required by Anthropic SDK for large maxTokens
export const model = await initChatModel("claude-sonnet-4-6", {
    temperature: 0.3,
    timeout: 300,
    maxTokens: 25_000,
    streaming: true,
});

// Non-streaming model for withStructuredOutput — streaming breaks JSON accumulation
export const extractionModel = await initChatModel("claude-sonnet-4-6", {
    temperature: 0,
    timeout: 60,
    maxTokens: 2_000,
    streaming: false,
});
