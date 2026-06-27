import { AIMessage, SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { TravelState, type TravelMember } from "../state.js";
import { extractionModel } from "../model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The system prompt lives in a markdown file so it can be read and edited without
 * touching TypeScript. It instructs the model on how to extract trip details:
 * date parsing ("10 days from now"), age defaults (adults = 35, children = null), etc.
 */
const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, "../markdown/travel-system-prompt.md"),
    "utf-8"
);

/**
 * TripDetailsSchema is a Zod schema that defines the exact JSON shape the LLM must return.
 * `withStructuredOutput(schema)` compiles this into an Anthropic tool-call definition,
 * which forces the model to fill every field — no free-text, no missing keys, no hallucinated
 * field names. The model is essentially "called" like a typed function.
 */
const TripDetailsSchema = z.object({
    infoComplete: z.boolean().describe(
        "True only when all 5 fields (origin, destination, startDate, returnDate, members with no null ages) are present"
    ),
    origin: z.string().describe("Departure city or airport — never omit, default to 'Not specified' if unknown"),
    destination: z.string().describe("Travel destination city and country"),
    startDate: z.string().describe("Departure date in YYYY-MM-DD format"),
    returnDate: z.string().describe(
        "Return date in YYYY-MM-DD format — calculate from startDate + duration if user gave number of days"
    ),
    members: z
        .array(
            z.object({
                name: z.string().describe("Auto-generate as adult_1, child_1, etc. if not given"),
                age: z.number().nullable().describe("Age as a number; null only when child age is truly unspecified"),
            })
        )
        .describe("All travelers with names and ages"),
    followUpQuestion: z.string().describe(
        "Required when infoComplete is false: one consolidated question for ALL missing info. Empty string when infoComplete is true."
    ),
});

/**
 * collectInfoNode — first node in the graph; runs on every user message.
 *
 * Responsibilities:
 *   1. Retrieve long-term memories (preferences, companions, past trips) from MongoDBStore
 *      and inject them into the system prompt so the model already "knows" the user.
 *   2. Extract structured trip details from the conversation using withStructuredOutput.
 *   3. Return partial state: either the full trip details (→ graph proceeds to search)
 *      or a follow-up question as an AIMessage (→ graph waits for the user's next message).
 *
 * The second `config` parameter is injected by LangGraph and carries the memory store,
 * the thread_id, and other runtime context. Nodes opt in to config by declaring it.
 */
export async function collectInfoNode(
    state: typeof TravelState.State,
    config?: LangGraphRunnableConfig,
): Promise<Partial<typeof TravelState.State>> {

    // ── Step 1: Retrieve long-term memories ─────────────────────────────────────
    // `getStore(config)` extracts the MongoDBStore that was attached in graph.compile().
    // On the very first ever trip (no memories saved yet) this will return empty arrays,
    // which is fine — memoryContext stays "" and the prompt is unchanged.
    const store = getStore(config);
    let memoryContext = "";

    if (store) {
        try {
            const [prefItems, tripItems, companionItem] = await Promise.all([
                // Retrieve all preference keys (travel_style, budget, seating, etc.)
                store.search(["user", "default", "preferences"], { limit: 1 }),
                // Retrieve the 5 most recent past trips
                store.search(["user", "default", "trips"], { limit: 5 }),
                // Retrieve the saved companion list (family members from past trips)
                store.get(["user", "default", "preferences"], "companions"),
            ]);

            const prefs = prefItems.find(i => i.key === "travel_prefs")?.value;
            const companions = companionItem?.value?.members;
            // Exclude the preference and companion keys from trip results
            const recentTrips = tripItems.filter(i => i.key !== "travel_prefs" && i.key !== "companions");

            const lines: string[] = [];
            if (prefs && Object.keys(prefs).length > 0) {
                lines.push("Travel preferences: " + JSON.stringify(prefs));
            }
            if (companions && Array.isArray(companions) && companions.length > 0) {
                lines.push("Recurring travel companions: " + JSON.stringify(companions));
            }
            if (recentTrips.length > 0) {
                lines.push("Past trips:\n" + recentTrips.map(t => `  - ${JSON.stringify(t.value)}`).join("\n"));
            }

            if (lines.length > 0) {
                // This section is appended to the system prompt so the model uses it
                // to pre-fill known fields and skip questions already answered by memory.
                memoryContext = "\n\n## What I already know about this traveler\n" + lines.join("\n");
            }
        } catch {
            // Memory retrieval is best-effort — never block trip planning if store is unavailable
        }
    }

    // ── Step 2: Extract structured trip details from conversation ────────────────
    // `withStructuredOutput` wraps the model in a tool-call layer that guarantees
    // the response matches TripDetailsSchema exactly. It uses extractionModel
    // (non-streaming) because JSON must arrive as a complete string to be parsed.
    const structured = extractionModel.withStructuredOutput(TripDetailsSchema);

    const response = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT + memoryContext),
        ...state.messages,   // full conversation history so the model has all context
    ]);

    const hasUnknownAges = response.members?.some((m) => m.age === null) ?? false;

    // ── Step 3: Return state update ──────────────────────────────────────────────
    // If all required fields are present and all ages are known, mark info as collected.
    // routeAfterCollect() will then route to "proceed" → parallel searches.
    if (
        response.infoComplete &&
        !hasUnknownAges &&
        response.origin &&
        response.destination &&
        response.startDate &&
        response.returnDate &&
        response.members?.length
    ) {
        return {
            origin: response.origin,
            destination: response.destination,
            startDate: response.startDate,
            returnDate: response.returnDate,
            members: response.members as TravelMember[],
            infoCollected: true,
            retrievedMemories: memoryContext,   // stored in state for debugging/inspection
        };
    }

    // Info is incomplete — ask the user for what's missing.
    // Returning messages here appends the follow-up question to the conversation history
    // (via messagesStateReducer). routeAfterCollect() will route to END,
    // and the graph pauses until the user replies.
    const question =
        response.followUpQuestion?.trim() ||
        `I have: ${[
            response.origin && `origin: ${response.origin}`,
            response.destination && `destination: ${response.destination}`,
            response.startDate && `start: ${response.startDate}`,
            response.returnDate && `return: ${response.returnDate}`,
            response.members?.length && `${response.members.length} traveler(s)`,
        ]
            .filter(Boolean)
            .join(", ")}. Could you confirm the missing details (${
            [
                !response.startDate && "start date",
                !response.returnDate && "return date or trip duration",
                hasUnknownAges && "children's ages",
            ]
                .filter(Boolean)
                .join(", ")
        })?`;

    return {
        messages: [new AIMessage(question)],
        infoCollected: false,
        retrievedMemories: memoryContext,
    };
}
