import type Anthropic from "@anthropic-ai/sdk";

/**
 * Tool definitions — all Anthropic.Tool JSON schemas in one place.
 *
 * In LangGraph, tool schemas were generated automatically from Zod schemas:
 *   const schema = z.object({ ... })
 *   model.withStructuredOutput(schema)  // compiled Zod → JSON Schema internally
 *   tool(fn, { schema })                // same for bindTools()
 *
 * Here we write the JSON Schema directly as Anthropic.Tool objects.
 * There's no Zod, no code generation — what you see is what the API receives.
 * This makes the contract explicit: you can read exactly what the model is told.
 */

/**
 * collectInfoTool — forces the model to extract structured trip details from the conversation.
 *
 * Used with `tool_choice: { type: "tool", name: "extract_trip_details" }` so the model
 * ALWAYS calls this tool — it cannot reply with free text. This is the direct replacement
 * for `extractionModel.withStructuredOutput(TripDetailsSchema)` in collectInfoNode.
 *
 * The model fills every required field from the conversation history. If info is missing
 * it sets infoComplete: false and populates followUpQuestion with a single question
 * covering all gaps.
 */
export const collectInfoTool: Anthropic.Tool = {
    name: "extract_trip_details",
    description: "Extract structured trip information from the conversation. Call this every time the user sends a message to pull out what we know so far.",
    input_schema: {
        type: "object",
        properties: {
            infoComplete: {
                type: "boolean",
                description: "True only when all 5 fields (origin, destination, startDate, returnDate, members with no null ages) are present",
            },
            origin: {
                type: "string",
                description: "Departure city or airport — never omit, default to 'Not specified' if unknown",
            },
            destination: {
                type: "string",
                description: "Travel destination city and country",
            },
            startDate: {
                type: "string",
                description: "Departure date in YYYY-MM-DD format",
            },
            returnDate: {
                type: "string",
                description: "Return date in YYYY-MM-DD format — calculate from startDate + duration if user gave number of days",
            },
            members: {
                type: "array",
                description: "All travelers with names and ages",
                items: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: "Auto-generate as adult_1, child_1 etc. if not given",
                        },
                        age: {
                            type: ["number", "null"],
                            description: "Age as a number; null only when child age is truly unspecified",
                        },
                    },
                    required: ["name", "age"],
                },
            },
            followUpQuestion: {
                type: "string",
                description: "Required when infoComplete is false: one consolidated question for ALL missing info. Empty string when infoComplete is true.",
            },
        },
        required: ["infoComplete", "origin", "destination", "startDate", "returnDate", "members", "followUpQuestion"],
    },
};

/**
 * entertainmentTool — used in getEntertainment() with normal tool calling (no forced choice).
 *
 * The model decides whether to call this tool based on the entertainment prompt.
 * If it calls it, we execute searchEntertainment() and return the raw result.
 * If it answers directly (fallback), we use the text response instead.
 *
 * This mirrors how entertainmentNode used `model.bindTools([searchEntertainment])` in LangGraph —
 * the model chose when to call the tool; we just detected `response.tool_calls?.length`.
 */
export const entertainmentTool: Anthropic.Tool = {
    name: "search_entertainment",
    description: "Find entertainment, activities, and attractions at a destination. Filters results by weather suitability and age appropriateness.",
    input_schema: {
        type: "object",
        properties: {
            destination: {
                type: "string",
                description: "City or region to find activities in",
            },
            weatherCondition: {
                type: "string",
                description: "Weather during the trip, e.g. 'sunny and warm', 'rainy', 'cold and snowy'",
            },
            kidFriendly: {
                type: "boolean",
                description: "True if any group member is under 12 years old — enables family/kid-friendly filter",
            },
            categories: {
                type: "array",
                items: { type: "string" },
                description: "Activity categories to search, e.g. ['outdoor', 'museum', 'beach', 'indoor', 'adventure', 'cultural', 'food']",
            },
        },
        required: ["destination", "weatherCondition", "kidFriendly", "categories"],
    },
};

/**
 * memoryExtractionTool — forces the model to extract persistent memory from a completed trip.
 *
 * Used in memory.ts `saveMemory()` with `tool_choice: { type: "tool", name: "extract_memory" }`.
 * Replaces `extractionModel.withStructuredOutput(MemorySchema)` from saveMemoryNode.
 *
 * Two categories extracted:
 *   - preferences: durable facts about HOW the user travels (seat, budget, hotel stars, etc.)
 *                  Survives across all future trips — only filled when explicitly stated.
 *   - tripSummary: facts about THIS specific trip (destination, dates, 3 highlights, best hotel).
 *                  Keyed by "destination-startDate" so each trip is stored separately.
 *
 * `hasPreferences` is a flag the model sets to true if any preferences field is non-empty.
 * We use it to skip the preferences upsert entirely when no preferences were mentioned —
 * avoids overwriting existing preferences with an empty object.
 */
export const memoryExtractionTool: Anthropic.Tool = {
    name: "extract_memory",
    description: "Extract travel preferences and a trip summary from a completed planning conversation.",
    input_schema: {
        type: "object",
        properties: {
            preferences: {
                type: "object",
                description: "Durable travel preferences explicitly stated by the user — omit fields not mentioned",
                properties: {
                    seating:           { type: "string", description: "Seat preference (window / aisle / no preference)" },
                    budget_usd:        { type: "string", description: "Approximate total trip budget in USD" },
                    hotel_stars:       { type: "string", description: "Preferred hotel star rating e.g. '4+' or '3-5'" },
                    travel_style:      { type: "string", description: "Travel style: luxury, budget, adventure, family, etc." },
                    dietary:           { type: "string", description: "Dietary restrictions or food preferences" },
                    flight_preference: { type: "string", description: "Direct only, max 1 stop, economy vs business, etc." },
                },
            },
            tripSummary: {
                type: "object",
                description: "Summary of this specific completed trip",
                properties: {
                    destination:      { type: "string" },
                    startDate:        { type: "string" },
                    returnDate:       { type: "string" },
                    members: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                age:  { type: ["number", "null"] },
                            },
                            required: ["name", "age"],
                        },
                    },
                    highlights:       {
                        type: "array",
                        items: { type: "string" },
                        description: "3 notable results found (e.g. a hotel name, activity, flight option)",
                    },
                    hotelRecommended: { type: "string", description: "Best hotel option surfaced" },
                },
                required: ["destination", "startDate", "returnDate", "members", "highlights"],
            },
            hasPreferences: {
                type: "boolean",
                description: "True if any preferences field above is non-empty",
            },
        },
        required: ["preferences", "tripSummary", "hasPreferences"],
    },
};

/**
 * routerTool — forces the meta-router to classify every user message into one of 7 actions.
 *
 * Used in metaRouter.ts with `tool_choice: { type: "tool", name: "classify_intent" }`.
 * Replaces `extractionModel.withStructuredOutput(RouterSchema)` from LangGraph.
 * The forced tool call guarantees the model always returns one of the enum actions —
 * it can never fall back to free text, so classifyIntent() always gets a valid RouterDecision.
 */
export const routerTool: Anthropic.Tool = {
    name: "classify_intent",
    description: "Classify the user's message into a session management action.",
    input_schema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["continue", "new_plan", "switch_plan", "list_plans", "delete_plan", "clear_all", "exit"],
                description: "The action to take based on the user's intent",
            },
            suggestedName: {
                type: "string",
                description: "Kebab-case slug for new_plan, e.g. 'new-york-jul24'",
            },
            description: {
                type: "string",
                description: "Short human label for new_plan, e.g. 'New York, Jul 24–30'",
            },
            planName: {
                type: "string",
                description: "Matching plan name for switch_plan or delete_plan actions",
            },
        },
        required: ["action"],
    },
};
