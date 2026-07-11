import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic, MODEL, FAST_MODEL } from "./client.js";
import { emptyState, type TravelState, type TravelMember } from "./state.js";
import { saveState, loadState } from "./db.js";
import { loadMemory, saveMemory } from "./memory.js";
import { collectInfoTool, entertainmentTool } from "./tools/definitions.js";
import { searchFlights } from "./tools/searchFlights.js";
import { searchHotels } from "./tools/searchHotels.js";
import { getWeather } from "./tools/getWeather.js";
import { searchEntertainment } from "./tools/searchEntertainment.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load all prompts once at module startup — same pattern as LearningLangChart.
const TRAVEL_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "markdown/travel-system-prompt.md"), "utf-8");
const ENTERTAINMENT_PROMPT = fs.readFileSync(path.join(__dirname, "markdown/entertainment-prompt.md"), "utf-8");
const COMPILE_PLAN_PROMPT  = fs.readFileSync(path.join(__dirname, "markdown/compile-plan-prompt.md"),  "utf-8");
const REFINEMENT_PROMPT    = fs.readFileSync(path.join(__dirname, "markdown/refinement-prompt.md"),    "utf-8");

// ── Types for tool call inputs (what the model returns in tool_use blocks) ────

/** Shape of the extract_trip_details tool call input. */
interface TripDetails {
    infoComplete: boolean;
    origin: string;
    destination: string;
    startDate: string;
    returnDate: string;
    members: TravelMember[];
    followUpQuestion: string;
}

/** Shape of the search_entertainment tool call input. */
interface EntertainmentArgs {
    destination: string;
    weatherCondition: string;
    kidFriendly: boolean;
    categories: string[];
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * extractText — joins all TextBlock content from an Anthropic response into a single string.
 * Needed because response.content is an array of ContentBlock (text | tool_use | etc.).
 * In LangGraph, model.invoke() returned a BaseMessage whose .content was already a string.
 */
function extractText(content: Anthropic.ContentBlock[]): string {
    return content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("");
}

// ── collectInfo ───────────────────────────────────────────────────────────────

/**
 * collectInfo — extracts structured trip details from the conversation.
 *
 * LangGraph equivalent: collectInfoNode using extractionModel.withStructuredOutput(TripDetailsSchema).
 *
 * How it works:
 *   - We pass `tool_choice: { type: "tool", name: "extract_trip_details" }` which FORCES
 *     the model to call that specific tool — it cannot reply with free text.
 *   - The model fills every field in collectInfoTool's input_schema from the conversation.
 *   - We read the `tool_use` block from response.content to get the structured result.
 *
 * This is exactly what withStructuredOutput() was doing internally: it compiled a Zod
 * schema into an Anthropic tool definition and set tool_choice to force the call.
 * Here we do both steps explicitly ourselves.
 *
 * @param memoryContext  Pre-loaded memory string from loadMemory(), appended to the system
 *                       prompt so the model can pre-fill companions, budget, seat preference
 *                       without asking again. Empty string on the very first ever trip.
 */
async function collectInfo(state: TravelState, memoryContext: string): Promise<TripDetails> {
    const response = await anthropic.messages.create({
        model: FAST_MODEL,   // pure JSON extraction — Haiku is sufficient and ~20× cheaper
        max_tokens: 1024,
        system: TRAVEL_SYSTEM_PROMPT + memoryContext,
        tools: [collectInfoTool],
        tool_choice: { type: "tool", name: "extract_trip_details" },
        messages: state.messages,
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) throw new Error("collectInfo: model did not call extract_trip_details");
    return toolUse.input as TripDetails;
}

// ── getEntertainment ──────────────────────────────────────────────────────────

/**
 * getEntertainment — asks the model to call search_entertainment, then executes the tool.
 *
 * LangGraph equivalent: entertainmentNode using model.bindTools([searchEntertainment]).
 *
 * Key difference from collectInfo: we do NOT use tool_choice here — the model decides
 * whether to call the tool based on the entertainment prompt ("Always call the tool").
 * If it does call it, we detect `stop_reason === "tool_use"`, extract the tool call input,
 * and run searchEntertainment() ourselves.
 *
 * In LangGraph, model.bindTools() registered the tool and LangChain automatically
 * detected and invoked it. Here we detect and invoke manually.
 *
 * The text fallback handles the edge case where the model ignores the prompt and
 * answers directly — we accept its text response rather than crashing.
 */
async function getEntertainment(state: TravelState): Promise<string> {
    const userContext =
        `Destination: ${state.destination}\n` +
        `Travel dates: ${state.startDate} to ${state.returnDate}\n` +
        `Travelers: ${JSON.stringify(state.members)}\n` +
        `Weather summary: ${state.weatherSummary}`;

    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: ENTERTAINMENT_PROMPT,
        tools: [entertainmentTool],
        messages: [{ role: "user", content: userContext }],
    });

    if (response.stop_reason === "tool_use") {
        const toolCall = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolCall) {
            return await searchEntertainment(toolCall.input as EntertainmentArgs);
        }
    }

    // Fallback: model answered directly — use its text
    return extractText(response.content);
}

// ── compilePlan ───────────────────────────────────────────────────────────────

/**
 * compilePlan — synthesises all search results into the final markdown travel plan.
 *
 * LangGraph equivalent: compilePlanNode using model (streaming, 25k tokens).
 *
 * Runs once, after all parallel searches and entertainment are complete. Bundles
 * every piece of collected state into a structured prompt and asks the model to
 * format it as a comprehensive travel plan.
 *
 * No streaming here — we wait for the full response before returning. The plan
 * text is stored in state.finalPlan and also appended to messages so refinement
 * can reference it in follow-up questions.
 */
async function compilePlan(state: TravelState): Promise<string> {
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

    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,   // 25k was the LangGraph streaming workaround; 8k fits a full plan
        system: COMPILE_PLAN_PROMPT,
        messages: [{ role: "user", content: tripData }],
    });

    return extractText(response.content);
}

// ── refine ────────────────────────────────────────────────────────────────────

/**
 * refine — answers a follow-up question about an already-delivered plan.
 *
 * LangGraph equivalent: refinementNode.
 *
 * Runs when conversationStage === "planned" — the plan was already sent to the user
 * and they're asking something like "what about cheaper hotels?" or "what if we stay longer?".
 *
 * Instead of re-running all searches, we pass the full original plan + all raw data
 * as context so the model can answer from what was already gathered.
 *
 * Finding the last user message: in LangGraph this used `m._getType() === "human"`.
 * Here we check `m.role === "user"` on plain MessageParam objects.
 */
async function refine(state: TravelState): Promise<string> {
    const lastUserMessage = [...state.messages]
        .reverse()
        .find(m => m.role === "user");

    const context =
        `## Original Travel Plan\n${state.finalPlan}\n\n` +
        `## Raw Flight Data\n${state.flightResults || "Not available"}\n\n` +
        `## Raw Hotel Data\n${state.hotelResults || "Not available"}\n\n` +
        `## Weather Summary\n${state.weatherSummary || "Not available"}\n\n` +
        `## Entertainment Options\n${state.entertainmentOptions || "Not available"}`;

    const userQuestion =
        typeof lastUserMessage?.content === "string"
            ? lastUserMessage.content
            : JSON.stringify(lastUserMessage?.content ?? "");

    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: REFINEMENT_PROMPT,
        messages: [{ role: "user", content: `${context}\n\n---\nUser follow-up question: ${userQuestion}` }],
    });

    return extractText(response.content);
}

// ── runTravelAgent ────────────────────────────────────────────────────────────

/**
 * runTravelAgent — the main orchestration function; replaces the entire LangGraph StateGraph.
 *
 * In LangGraph the graph was declared statically with nodes + edges + conditional edges,
 * and the framework walked the graph on each invoke() call. Here the same logic is written
 * as plain TypeScript if/else + Promise.all().
 *
 * Execution paths:
 *
 *   1. Info incomplete:
 *      loadState → push user message → collectInfo() → ask follow-up → saveState → return
 *      (replaces: collectInfoNode → routeAfterCollect → END)
 *
 *   2. Plan already delivered (refinement):
 *      loadState → push user message → skip collectInfo (infoCollected=true) → refine() → saveState → return
 *      (replaces: collectInfoNode → routeAfterCollect → "refine" → refinementNode → END)
 *
 *   3. New plan — all info collected:
 *      loadState → push user message → collectInfo() → Promise.all([flights,hotels,weather])
 *      → getEntertainment() → compilePlan() → saveState → return
 *      (replaces: collectInfoNode → routeAfterCollect → "proceed" → parallelDispatch
 *       → Send()[searchFlights, searchHotels, searchWeather] → entertainment → compilePlan → END)
 *
 * @param threadId    Unique identifier for this plan's conversation — maps to a MongoDB document.
 * @param userMessage The raw text the user just typed in the REPL.
 * @returns           The updated TravelState after processing the message.
 */
export async function runTravelAgent(threadId: string, userMessage: string): Promise<TravelState> {
    // Resume from saved state or start fresh — replaces LangGraph's checkpoint resume.
    const state = (await loadState(threadId)) ?? emptyState();

    // Append the new user message — replaces messagesStateReducer.
    state.messages.push({ role: "user", content: userMessage });

    // Load long-term memories once per turn and pass them into collectInfo().
    // In LangGraph this happened inside collectInfoNode via getStore(config).
    // Here we load eagerly at the top of the turn and pass the string down.
    // Only needed while collecting — once infoCollected, memories are no longer used.
    const memoryContext = state.infoCollected ? "" : await loadMemory();

    // ── Path 1: Still collecting trip info ────────────────────────────────────
    if (!state.infoCollected) {
        const info = await collectInfo(state, memoryContext);
        const hasUnknownAges = info.members?.some(m => m.age === null) ?? false;

        if (
            info.infoComplete &&
            !hasUnknownAges &&
            info.origin &&
            info.destination &&
            info.startDate &&
            info.returnDate &&
            info.members?.length
        ) {
            // All info present — assign to state and fall through to searches below.
            state.origin      = info.origin;
            state.destination = info.destination;
            state.startDate   = info.startDate;
            state.returnDate  = info.returnDate;
            state.members     = info.members;
            state.infoCollected = true;
        } else {
            // Still missing info — ask the follow-up question and stop here.
            // The user's next message will resume from this saved state.
            const question = info.followUpQuestion?.trim() || `Could you confirm the missing details?`;
            state.messages.push({ role: "assistant", content: question });
            await saveState(threadId, state);
            return state;
        }
    }

    // ── Path 2: Plan already delivered → answer follow-up ─────────────────────
    // Replaces: routeAfterCollect returning "refine" → refinementNode
    if (state.conversationStage === "planned") {
        const answer = await refine(state);
        state.messages.push({ role: "assistant", content: answer });
        await saveState(threadId, state);
        return state;
    }

    // ── Path 3: Info complete, no plan yet → parallel searches + compile ───────
    // Promise.all replaces LangGraph's Send() fan-out — same effect, plain JS.
    //
    // Skip guard: if state already has results (e.g. the process crashed mid-run
    // after searches completed but before compilePlan), don't repeat the API calls.
    const memberCount = state.members.length || 1;

    if (!state.flightResults && !state.hotelResults && !state.weatherSummary) {
        const [flights, hotels, weather] = await Promise.all([
            searchFlights({
                origin:      state.origin,
                destination: state.destination,
                startDate:   state.startDate,
                returnDate:  state.returnDate,
                memberCount,
            }),
            searchHotels({
                destination: state.destination,
                checkIn:     state.startDate,
                checkOut:    state.returnDate,
                memberCount,
            }),
            getWeather({ city: state.destination, date: state.startDate }),
        ]);
        state.flightResults  = flights;
        state.hotelResults   = hotels;
        state.weatherSummary = weather;
    }

    // Entertainment runs after weather (needs weatherSummary for category selection).
    if (!state.entertainmentOptions) {
        state.entertainmentOptions = await getEntertainment(state);
    }

    // Compile the final plan from all gathered data.
    state.finalPlan          = await compilePlan(state);
    state.conversationStage  = "planned";

    // Add plan to message history so refine() can reference it in follow-ups.
    state.messages.push({ role: "assistant", content: state.finalPlan });

    // Single saveState call at the end — replaces MongoDBSaver's auto-save after each node.
    await saveState(threadId, state);

    // Save long-term memories after the plan is persisted.
    // Replaces saveMemoryNode which ran as a dedicated graph node after compilePlanNode.
    // Errors are swallowed inside saveMemory() — a memory failure never breaks a delivered plan.
    await saveMemory(state);

    return state;
}
