import { AIMessage, SystemMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TravelState } from "../state.js";
import { model } from "../model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * System prompt that instructs the model on how to format the final plan:
 * markdown sections for flights, hotels, weather, entertainment, budget estimate, packing tips.
 */
const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, "../markdown/compile-plan-prompt.md"),
    "utf-8"
);

/**
 * compilePlanNode — synthesises all search results into the final markdown travel plan.
 *
 * Runs once, after all three parallel searches and entertainment have completed.
 * At this point the state holds raw scraped data from flights, hotels, weather, and
 * activities. This node's job is to ask the model to turn that raw data into a
 * structured, human-readable plan.
 *
 * Uses `model` (streaming, 25k tokens) because the compiled plan can be long and
 * Anthropic requires streaming for high token outputs.
 *
 * Key side-effect: sets `conversationStage: "planned"`. This is the flag that causes
 * `routeAfterCollect` to route ALL future messages to `refinementNode` instead of
 * re-running the search pipeline. Without this, every follow-up question would
 * trigger a fresh search — expensive and slow.
 */
export async function compilePlanNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {

    // Bundle all collected data into a single structured string for the model.
    // The system prompt tells the model how to format each section.
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

    // model.invoke returns a BaseMessage whose content can be a string or a
    // structured content array (for multi-modal responses). We normalise to string.
    const plan =
        typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);

    return {
        finalPlan: plan,
        // Flip the conversation stage — this persists in MongoDBSaver so the agent
        // knows it's in refinement mode even after a process restart.
        conversationStage: "planned" as const,
        // Add the plan to the message history so refinementNode can reference it
        // when answering follow-up questions.
        messages: [new AIMessage(plan)],
    };
}
