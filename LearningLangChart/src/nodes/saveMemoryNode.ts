import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { TravelState } from "../state.js";
import { extractionModel } from "../model.js";

/**
 * MemorySchema defines what the model must extract from the completed trip conversation.
 * Two categories:
 *   - preferences: durable facts about HOW this person likes to travel (survives across all future trips)
 *   - tripSummary: facts about THIS specific trip (destination, dates, what was found)
 *
 * Using withStructuredOutput here (instead of asking for raw JSON) guarantees the shape
 * and avoids JSON parse failures from free-text model output.
 */
const MemorySchema = z.object({
    preferences: z.object({
        seating: z.string().optional().describe("Seat preference (window / aisle / no preference)"),
        budget_usd: z.string().optional().describe("Approximate total trip budget in USD"),
        hotel_stars: z.string().optional().describe("Preferred hotel star rating e.g. '4+' or '3-5'"),
        travel_style: z.string().optional().describe("Travel style: luxury, budget, adventure, family, etc."),
        dietary: z.string().optional().describe("Dietary restrictions or food preferences"),
        flight_preference: z.string().optional().describe("Direct only, max 1 stop, economy vs business, etc."),
    }).describe("Preferences explicitly stated during this conversation — omit fields not mentioned"),
    tripSummary: z.object({
        destination: z.string(),
        startDate: z.string(),
        returnDate: z.string(),
        members: z.array(z.object({ name: z.string(), age: z.number().nullable() })),
        highlights: z.array(z.string()).describe("3 notable results found (e.g. a hotel name, activity, flight option)"),
        hotelRecommended: z.string().optional().describe("Best hotel option surfaced"),
    }),
    hasPreferences: z.boolean().describe("True if any preferences field above is non-empty"),
});

/**
 * Memory extraction prompt. The key instruction is "only fill fields that were
 * explicitly stated" — this prevents the model from guessing or hallucinating
 * preferences the user never mentioned.
 */
const EXTRACT_PROMPT = `You are a travel memory extractor. Given a travel planning conversation and the final plan, extract two things:

1. **preferences**: Travel preferences the user *explicitly stated* (seat, budget, hotel rating, travel style, dietary, flight preference). Only fill fields that were directly mentioned — do not guess.
2. **tripSummary**: A compact summary of this specific trip (destination, dates, travelers, 3 highlights, best hotel found).

Return structured data only. Be concise.`;

/**
 * saveMemoryNode — runs once after compilePlanNode, as a "side-effect" node.
 *
 * This node implements the LONG-TERM MEMORY write path:
 *   1. Ask the LLM to extract preferences and a trip summary from the conversation
 *   2. Store them in MongoDBStore under namespaced keys
 *
 * Memory namespace design:
 *   ["user", "default", "preferences"]  key: "travel_prefs"  → { seating, budget, hotel_stars, ... }
 *   ["user", "default", "preferences"]  key: "companions"    → { members: [{name, age}, ...] }
 *   ["user", "default", "trips"]        key: "alaska-2026-07-15" → { destination, dates, highlights, ... }
 *
 * The namespace is like a folder path — it lets you search scoped to a subtree.
 * Keys within a namespace are like file names.
 *
 * Returns `{}` (empty object) because this node only has side effects; it does not
 * need to update any graph state. LangGraph still checkpoints the run, but the
 * TravelState fields remain unchanged.
 */
export async function saveMemoryNode(
    state: typeof TravelState.State,
    config?: LangGraphRunnableConfig,
): Promise<Partial<typeof TravelState.State>> {

    // If no store is attached (e.g. during testing) or plan was never completed, skip silently.
    const store = getStore(config);
    if (!store || !state.finalPlan) return {};

    // ── Extract memories from the completed conversation ─────────────────────────
    let extracted: z.infer<typeof MemorySchema>;
    try {
        const structured = extractionModel.withStructuredOutput(MemorySchema);
        extracted = await structured.invoke([
            new SystemMessage(EXTRACT_PROMPT),
            new HumanMessage(
                // Pass the full conversation + final plan so the model has everything it needs
                `Conversation:\n${state.messages.map(m => `${m._getType()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n")}\n\nFinal Plan:\n${state.finalPlan}`
            ),
        ]);
    } catch {
        // If extraction fails (timeout, parse error), skip memory save rather than crashing
        return {};
    }

    // ── Build a stable key for this trip ─────────────────────────────────────────
    // e.g. "alaska-2026-07-15" — destination + start date makes it unique and human-readable.
    // This key is what collectInfoNode uses later to retrieve past trips for this destination.
    const tripKey = `${state.destination?.toLowerCase().replace(/[\s,]+/g, "-")}-${state.startDate}`;

    // ── Write to MongoDBStore in parallel ────────────────────────────────────────
    const ops: Promise<void>[] = [
        // Always save the trip summary — even if the user stated no preferences
        store.put(["user", "default", "trips"], tripKey, extracted.tripSummary as Record<string, unknown>),
    ];

    if (extracted.hasPreferences) {
        // Filter out undefined/empty values before storing to keep the document clean
        const prefs = Object.fromEntries(
            Object.entries(extracted.preferences).filter(([, v]) => v !== undefined && v !== "")
        );
        // Upsert: `put` with the same key overwrites the previous value, so preferences
        // accumulate across trips (last-write-wins per field via repeated put calls).
        ops.push(store.put(["user", "default", "preferences"], "travel_prefs", prefs));
    }

    if (state.members.length > 0) {
        // Save the companion list (names + ages) so future trips pre-fill the travelers field.
        ops.push(store.put(["user", "default", "preferences"], "companions", { members: state.members }));
    }

    await Promise.all(ops);
    console.log(`\n[Memory] Saved trip "${tripKey}" and preferences to long-term store.\n`);
    return {};
}
