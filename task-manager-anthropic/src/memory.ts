
import { anthropic, FAST_MODEL } from "./client.js";
import { mongoClient } from "./db.js";
import { memoryExtractionTool } from "./tools/definitions.js";
import type { TravelState } from "./state.js";

/**
 * Long-term memory — cross-session user knowledge that persists beyond individual plans.
 *
 * In LangGraph this was backed by MongoDBStore, a key-value store with namespaced
 * search. LangGraph injected it into every node via `getStore(config)`.
 * Here we talk to the same `long_term_memory` MongoDB collection directly.
 *
 * Document shape: { namespace: string, key: string, value: object, updatedAt: Date }
 *
 * Three keys are stored:
 *   namespace "user/default/preferences"  key "travel_prefs" → { seating, budget, hotel_stars, ... }
 *   namespace "user/default/preferences"  key "companions"   → { members: [{name, age}] }
 *   namespace "user/default/trips"        key "<dest-date>"  → { destination, dates, highlights, ... }
 */

/** Type for extracted preferences (mirrors MemorySchema.preferences). */
interface TravelPreferences {
    seating?: string;
    budget_usd?: string;
    hotel_stars?: string;
    travel_style?: string;
    dietary?: string;
    flight_preference?: string;
}

/** Type for a trip summary stored in long_term_memory. */
interface TripSummary {
    destination: string;
    startDate: string;
    returnDate: string;
    members: Array<{ name: string; age: number | null }>;
    highlights: string[];
    hotelRecommended?: string;
}

/** Type for the full extracted memory blob returned by the model. */
interface ExtractedMemory {
    preferences: TravelPreferences;
    tripSummary: TripSummary;
    hasPreferences: boolean;
}

function db() { return mongoClient.db(process.env.MONGODB_DB!); }
function col() { return db().collection("long_term_memory"); }

// ── loadMemory ────────────────────────────────────────────────────────────────

/**
 * loadMemory — reads all stored memories and formats them as a prompt injection string.
 *
 * LangGraph equivalent: the store.search() + store.get() block in collectInfoNode
 * that built `memoryContext` before calling withStructuredOutput.
 *
 * The returned string is appended to the travel-system-prompt so collectInfo()
 * can pre-fill known fields (companions, budget, seat preference) without asking.
 * Returns "" on the very first trip (no documents yet) or on any read error.
 */
export async function loadMemory(): Promise<string> {
    try {
        const [prefsDoc, companionsDoc, recentTrips] = await Promise.all([
            // Travel preferences (single document, upserted on each trip completion)
            col().findOne({ namespace: "user/default/preferences", key: "travel_prefs" }),
            // Recurring companions list
            col().findOne({ namespace: "user/default/preferences", key: "companions" }),
            // Up to 5 most recent trip summaries, newest first
            col()
                .find({ namespace: "user/default/trips" })
                .sort({ updatedAt: -1 })
                .limit(5)
                .toArray(),
        ]);

        const lines: string[] = [];

        const prefs = prefsDoc?.value as TravelPreferences | undefined;
        if (prefs && Object.keys(prefs).length > 0) {
            lines.push("Travel preferences: " + JSON.stringify(prefs));
        }

        const companions = (companionsDoc?.value as { members?: unknown } | undefined)?.members;
        if (companions && Array.isArray(companions) && companions.length > 0) {
            lines.push("Recurring travel companions: " + JSON.stringify(companions));
        }

        if (recentTrips.length > 0) {
            lines.push(
                "Past trips:\n" +
                recentTrips.map(t => `  - ${JSON.stringify(t.value)}`).join("\n")
            );
        }

        if (lines.length === 0) return "";
        return "\n\n## What I already know about this traveler\n" + lines.join("\n");
    } catch {
        // Memory retrieval is best-effort — never block trip planning on a read error
        return "";
    }
}

// ── saveMemory ────────────────────────────────────────────────────────────────

/**
 * saveMemory — extracts preferences and a trip summary from the completed conversation
 * and writes them to the long_term_memory collection.
 *
 * LangGraph equivalent: saveMemoryNode — ran as a graph node after compilePlanNode,
 * used extractionModel.withStructuredOutput(MemorySchema) and wrote via store.put().
 *
 * Here we:
 *   1. Force a tool call (memoryExtractionTool) to extract structured memory — same
 *      mechanism as collectInfo(), replacing withStructuredOutput.
 *   2. Upsert the three document types directly to MongoDB (replacing store.put()).
 *
 * Called manually after compilePlan() in runTravelAgent(). Errors are swallowed
 * because a memory save failure should never crash an already-completed plan.
 *
 * @param state  The completed TravelState (must have finalPlan set).
 */
export async function saveMemory(state: TravelState): Promise<void> {
    if (!state.finalPlan) return;

    // Build the input: full conversation formatted as plain text + the final plan.
    // Replaces: messages.map(m => `${m._getType()}: ${m.content}`) — MessageParam has .role directly.
    const conversationText = state.messages
        .map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n\n");

    const EXTRACT_PROMPT = `You are a travel memory extractor. Given a travel planning conversation and the final plan, extract two things:

1. **preferences**: Travel preferences the user *explicitly stated* (seat, budget, hotel rating, travel style, dietary, flight preference). Only fill fields that were directly mentioned — do not guess.
2. **tripSummary**: A compact summary of this specific trip (destination, dates, travelers, 3 highlights, best hotel found).

Return structured data only. Be concise.`;

    let extracted: ExtractedMemory;
    try {
        // Forced tool call — replaces extractionModel.withStructuredOutput(MemorySchema)
        const response = await anthropic.messages.create({
            model: FAST_MODEL,   // pure JSON extraction — Haiku is sufficient and cheaper
            max_tokens: 1024,
            system: EXTRACT_PROMPT,
            tools: [memoryExtractionTool],
            tool_choice: { type: "tool", name: "extract_memory" },
            messages: [{
                role: "user",
                content: `Conversation:\n${conversationText}\n\nFinal Plan:\n${state.finalPlan}`,
            }],
        });

        const toolUse = response.content.find(b => b.type === "tool_use");
        if (!toolUse || toolUse.type !== "tool_use") return;
        extracted = toolUse.input as ExtractedMemory;
    } catch {
        // Extraction failure should not crash the agent — plan is already delivered
        return;
    }

    // Build a stable trip key: "kathmandu-nepal-2026-07-15"
    // Same pattern as LearningLangChart's tripKey construction in saveMemoryNode.
    const tripKey = `${state.destination.toLowerCase().replace(/[\s,]+/g, "-")}-${state.startDate}`;

    // Write all three document types in parallel — replaces store.put() calls.
    // Using upsert so repeated trips to the same destination update rather than duplicate.
    const ops: Promise<unknown>[] = [
        col().updateOne(
            { namespace: "user/default/trips", key: tripKey },
            { $set: { namespace: "user/default/trips", key: tripKey, value: extracted.tripSummary, updatedAt: new Date() } },
            { upsert: true }
        ),
    ];

    if (extracted.hasPreferences) {
        // Filter out undefined/empty fields before storing — keeps documents clean
        const prefs = Object.fromEntries(
            Object.entries(extracted.preferences).filter(([, v]) => v !== undefined && v !== "")
        );
        ops.push(
            col().updateOne(
                { namespace: "user/default/preferences", key: "travel_prefs" },
                { $set: { namespace: "user/default/preferences", key: "travel_prefs", value: prefs, updatedAt: new Date() } },
                { upsert: true }
            )
        );
    }

    if (state.members.length > 0) {
        // Save companion list so future trips pre-fill the travelers field
        ops.push(
            col().updateOne(
                { namespace: "user/default/preferences", key: "companions" },
                { $set: { namespace: "user/default/preferences", key: "companions", value: { members: state.members }, updatedAt: new Date() } },
                { upsert: true }
            )
        );
    }

    await Promise.all(ops);
    console.log(`\n[Memory] Saved trip "${tripKey}" and preferences to long-term store.\n`);
}
