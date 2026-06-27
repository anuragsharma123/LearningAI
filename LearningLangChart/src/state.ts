import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export type TravelMember = { name: string; age: number | null };

/**
 * TravelState is the shared memory of the entire LangGraph workflow.
 *
 * `Annotation.Root()` defines a typed state schema for a LangGraph graph. Each field
 * declares its TypeScript type AND a reducer — a function that controls how state is
 * merged when two nodes write to the same field simultaneously (e.g. in parallel branches).
 *
 * LangGraph passes the full state object into every node and merges each node's partial
 * return value back using these reducers. Nodes only need to return the fields they change.
 */
export const TravelState = Annotation.Root({

    /**
     * The conversation history — every user message and AI reply in order.
     * `messagesStateReducer` is LangGraph's built-in reducer that APPENDS new messages
     * rather than replacing the array. This means any node that returns
     * `{ messages: [new AIMessage("hi")] }` adds to the history, not overwrites it.
     */
    messages: Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
    }),

    // ── Trip details collected from the user ────────────────────────────────────
    // These use the default replace reducer (last write wins).

    /** Departure city or airport code (e.g. "SFO", "New York"). */
    origin: Annotation<string>(),

    /** Destination city and country (e.g. "Kathmandu, Nepal"). */
    destination: Annotation<string>(),

    /** Trip start date in YYYY-MM-DD format. */
    startDate: Annotation<string>(),

    /** Trip end date in YYYY-MM-DD format. */
    returnDate: Annotation<string>(),

    /**
     * All travelers with name and age. Custom reducer always takes the latest value
     * (`(_, b) => b`) so a complete updated member list from collectInfoNode replaces
     * whatever was there before.
     */
    members: Annotation<TravelMember[]>({
        reducer: (_, b) => b,
        default: () => [],
    }),

    // ── Search results from parallel workers ────────────────────────────────────

    /**
     * Raw flight search results (scraped HTML or fallback text).
     * Uses a CONCATENATION reducer so that when LangGraph runs searchFlightsNode
     * in parallel with hotels and weather via Send(), each worker can independently
     * write its results and they get merged together automatically.
     * Without concatenation, the last writer would erase the others.
     */
    flightResults: Annotation<string>({
        reducer: (a, b) => (a && b ? `${a}\n${b}` : a || b),
        default: () => "",
    }),

    /** Raw hotel search results — same concatenation pattern as flightResults. */
    hotelResults: Annotation<string>({
        reducer: (a, b) => (a && b ? `${a}\n${b}` : a || b),
        default: () => "",
    }),

    /** Weather JSON from wttr.in for the destination and travel dates. */
    weatherSummary: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),

    /** Entertainment and activity options (scraped from TripAdvisor or model fallback). */
    entertainmentOptions: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),

    /** The compiled markdown travel plan produced by compilePlanNode. */
    finalPlan: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),

    // ── Workflow control flags ───────────────────────────────────────────────────

    /**
     * Set to true by collectInfoNode once all 5 required fields (origin, destination,
     * startDate, returnDate, members with known ages) are present. The `routeAfterCollect`
     * function in travelAgent.ts reads this flag to decide whether to proceed to searches
     * or wait for more user input.
     */
    infoCollected: Annotation<boolean>({
        reducer: (_, b) => b,
        default: () => false,
    }),

    /**
     * Tracks which phase of the conversation we are in:
     * - "collecting" → still gathering trip info or running searches
     * - "planned"    → finalPlan has been delivered; next user message is a follow-up question
     *
     * Persisted by MongoDBSaver so the agent remembers where it left off across restarts.
     * The `routeAfterCollect` router reads this to route to refinementNode instead of
     * re-running the search pipeline.
     */
    conversationStage: Annotation<"collecting" | "planned">({
        reducer: (_, b) => b,
        default: () => "collecting",
    }),

    /**
     * Long-term memories retrieved from MongoDBStore at the start of collectInfoNode.
     * Stored in state so it's visible in LangGraph Studio / checkpoint inspector for
     * debugging — it shows exactly what context was injected into the system prompt.
     * Not used by any other node; purely informational once set.
     */
    retrievedMemories: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),
});
