import { AIMessage, SystemMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TravelState } from "../state.js";
import { model } from "../model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, "../markdown/refinement-prompt.md"),
    "utf-8"
);

export async function refinementNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    // Find the most recent human message (the follow-up question)
    const lastUserMessage = [...state.messages]
        .reverse()
        .find((m) => m._getType() === "human");

    const context =
        `## Original Travel Plan\n${state.finalPlan}\n\n` +
        `## Raw Flight Data\n${state.flightResults || "Not available"}\n\n` +
        `## Raw Hotel Data\n${state.hotelResults || "Not available"}\n\n` +
        `## Weather Summary\n${state.weatherSummary || "Not available"}\n\n` +
        `## Entertainment Options\n${state.entertainmentOptions || "Not available"}`;

    const response = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        {
            role: "user",
            content: `${context}\n\n---\nUser follow-up question: ${lastUserMessage?.content ?? ""}`,
        },
    ]);

    return { messages: [response instanceof AIMessage ? response : new AIMessage(String(response.content))] };
}
