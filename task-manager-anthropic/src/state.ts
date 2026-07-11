import type Anthropic from "@anthropic-ai/sdk";

/**
 * TravelMember — a single traveler with name and optional age.
 * Age is null only when the user mentions a child but hasn't given their age yet.
 * collectInfo() will ask for it before proceeding.
 */
export type TravelMember = { name: string; age: number | null };

/**
 * TravelState — the shared memory of the entire travel agent session.
 *
 * In LangGraph this was defined with `Annotation.Root()`, which attached a
 * REDUCER to every field controlling how parallel node writes are merged.
 * Here it's a plain TypeScript interface — a simple object you mutate directly.
 *
 * Key difference: in LangGraph the framework owned state and passed it into
 * every node. Here YOU own the state object, load it from MongoDB at the start
 * of each turn, mutate it, and save it back manually at the end.
 */
export interface TravelState {
    /**
     * Full conversation history as Anthropic.MessageParam[].
     * Replaces LangGraph's BaseMessage[] + messagesStateReducer.
     * We push to this array directly instead of relying on a reducer function.
     */
    messages: Anthropic.MessageParam[];

    // ── Trip fields collected from the user ────────────────────────────────────

    /** Departure city or airport (e.g. "SFO", "New York"). */
    origin: string;

    /** Destination city and country (e.g. "Kathmandu, Nepal"). */
    destination: string;

    /** Trip start date in YYYY-MM-DD format. */
    startDate: string;

    /** Trip return date in YYYY-MM-DD format. */
    returnDate: string;

    /**
     * All travelers with name and age.
     * In LangGraph this used a `(_, b) => b` reducer (last write wins).
     * Here we just assign: state.members = info.members.
     */
    members: TravelMember[];

    // ── Search results (populated in parallel by Promise.all) ─────────────────

    /**
     * Raw flight search results.
     * In LangGraph these used a concatenation reducer so parallel Send() branches
     * could each write without overwriting each other.
     * Here Promise.all() waits for all three and we assign sequentially, so no
     * reducer is needed.
     */
    flightResults: string;
    hotelResults: string;
    weatherSummary: string;
    entertainmentOptions: string;

    /** The compiled markdown travel plan produced by compilePlan(). */
    finalPlan: string;

    // ── Control flags ──────────────────────────────────────────────────────────

    /**
     * Set to true once all 5 required trip fields are collected and all ages known.
     * runTravelAgent() reads this to decide whether to ask a follow-up or proceed
     * to parallel searches. Replaces routeAfterCollect's infoCollected check.
     */
    infoCollected: boolean;

    /**
     * "collecting" → still gathering info or running searches.
     * "planned"    → finalPlan has been delivered; next message goes to refinement.
     *
     * Persisted in MongoDB so the agent resumes in the right mode after a restart.
     * Replaces the MongoDBSaver checkpoint that LangGraph wrote automatically.
     */
    conversationStage: "collecting" | "planned";
}

/**
 * emptyState — returns a zeroed TravelState for a brand-new thread.
 * Called when loadState() returns null (first message for this threadId).
 * Replaces LangGraph's default() factory on each Annotation field.
 */
export function emptyState(): TravelState {
    return {
        messages: [],
        origin: "",
        destination: "",
        startDate: "",
        returnDate: "",
        members: [],
        flightResults: "",
        hotelResults: "",
        weatherSummary: "",
        entertainmentOptions: "",
        finalPlan: "",
        infoCollected: false,
        conversationStage: "collecting",
    };
}
