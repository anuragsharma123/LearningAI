import { SystemMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TravelState } from "../state.js";
import { model } from "../model.js";
import searchEntertainment from "../tools/searchEntertainment.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, "../markdown/entertainment-prompt.md"),
    "utf-8"
);

const modelWithTools = model.bindTools([searchEntertainment]);

export async function entertainmentNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    const userContext =
        `Destination: ${state.destination}\n` +
        `Travel dates: ${state.startDate} to ${state.returnDate}\n` +
        `Travelers: ${JSON.stringify(state.members)}\n` +
        `Weather summary: ${state.weatherSummary}`;

    const response = await modelWithTools.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        { role: "user", content: userContext },
    ]);

    // If model made a tool call, execute it and collect the result
    if (response.tool_calls?.length) {
        const toolCall = response.tool_calls[0]!;
        const toolResult = await searchEntertainment.invoke(toolCall.args as Parameters<typeof searchEntertainment.invoke>[0]);
        const content = typeof toolResult === "string" ? toolResult : String(toolResult.content);
        return { entertainmentOptions: content };
    }

    // Model answered directly (fallback)
    return {
        entertainmentOptions:
            typeof response.content === "string"
                ? response.content
                : JSON.stringify(response.content),
    };
}
