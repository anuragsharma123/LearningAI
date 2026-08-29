import type { BaseMessage } from "@langchain/core/messages";

let inputTokens = 0;
let outputTokens = 0;
let modelCalls = 0;

/** Sums usage_metadata off every AIMessage in a result's message list into the running total. */
export function recordUsage(messages: BaseMessage[]): void {
  for (const m of messages) {
    const usage = (m as { usage_metadata?: { input_tokens: number; output_tokens: number } }).usage_metadata;
    if (usage) {
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      modelCalls += 1;
    }
  }
}

export function getTokenUsage() {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, modelCalls };
}

export function resetTokenUsage(): void {
  inputTokens = 0;
  outputTokens = 0;
  modelCalls = 0;
}
