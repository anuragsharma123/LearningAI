import { AIMessage, SystemMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TravelState } from "../state.js";
import { model } from "../model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, "../markdown/compile-plan-prompt.md"),
    "utf-8"
);

export async function compilePlanNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    const tripData =
        `## Trip Details\n` +
        `- Origin: ${state.origin}\n` +
        `- Destination: ${state.destination}\n` +
        `- Dates: ${state.startDate} → ${state.returnDate}\n` +
        `- Travelers: ${JSON.stringify(state.members)}\n\n` +
        `## Flight Search Results\n${state.flightResults || "No flight data available."}\n\n` +
        `## Hotel Search Results\n${state.hotelResults || "No hotel data available."}\n\n` +
        `## Weather Summary\n${state.weatherSummary || "No weather data available."}\n\n` +
        `## Entertainment Options\n${state.entertainmentOptions || "No entertainment data available."}`;

    const response = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        { role: "user", content: tripData },
    ]);

    const plan =
        typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);

    return {
        finalPlan: plan,
        messages: [new AIMessage(plan)],
    };
}
