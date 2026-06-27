import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { MongoDBSaver, MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
import { TravelState } from "./state.js";
import { mongoClient } from "./db.js";
import { collectInfoNode }   from "./nodes/collectInfoNode.js";
import { searchFlightsNode } from "./nodes/searchFlightsNode.js";
import { searchHotelsNode }  from "./nodes/searchHotelsNode.js";
import { searchWeatherNode } from "./nodes/searchWeatherNode.js";
import { entertainmentNode } from "./nodes/entertainmentNode.js";
import { compilePlanNode }   from "./nodes/compilePlanNode.js";
import { refinementNode }    from "./nodes/refinementNode.js";
import { saveMemoryNode }    from "./nodes/saveMemoryNode.js";

/**
 * routeAfterCollect — the main decision point of the graph (a "router" or "conditional edge").
 *
 * LangGraph calls this after every run of collectInfoNode. It returns a string that maps
 * to the name of the next node to visit. This is how you implement branching logic in a graph
 * without writing procedural if/else — the graph structure IS the logic.
 *
 * Three possible routes:
 *   "refine"  → plan was already delivered; this is a follow-up question → go to refinementNode
 *   "proceed" → all required trip info is collected → go to parallel search pipeline
 *   END       → info is still incomplete → stop and wait for the user's next message
 */
function routeAfterCollect(
    state: typeof TravelState.State
): "refine" | "proceed" | typeof END {
    if (state.conversationStage === "planned") return "refine";
    if (state.infoCollected) return "proceed";
    return END;
}

/**
 * dispatchSearches — fan-out function that launches three parallel searches simultaneously.
 *
 * `Send` is LangGraph's mechanism for dynamic parallel execution. Instead of a single
 * next node, this function returns an array of Send objects. LangGraph starts all three
 * nodes at the same time and waits for ALL of them to finish before advancing to the
 * next step (entertainmentNode). This is equivalent to `Promise.all()` in plain TypeScript,
 * but baked into the graph structure so each parallel branch is tracked and checkpointed.
 *
 * Each Send(nodeName, partialState) injects only the fields that node needs, so
 * searchFlightsNode doesn't receive hotel or weather data it doesn't use.
 */
function dispatchSearches(state: typeof TravelState.State): Send[] {
    return [
        new Send("searchFlights", {
            origin:      state.origin,
            destination: state.destination,
            startDate:   state.startDate,
            returnDate:  state.returnDate,
            members:     state.members,
        }),
        new Send("searchHotels", {
            destination: state.destination,
            startDate:   state.startDate,
            returnDate:  state.returnDate,
            members:     state.members,
        }),
        new Send("searchWeather", {
            destination: state.destination,
            startDate:   state.startDate,
        }),
    ];
}

/**
 * The graph declaration — this is the heart of a LangGraph application.
 *
 * `StateGraph(TravelState)` creates a directed graph where:
 *   - Each NODE is an async function that reads from state and returns a partial update
 *   - Each EDGE defines which node runs next
 *   - CONDITIONAL EDGES call a router function to pick the next node dynamically
 *
 * Full execution path for a new trip:
 *   START → collectInfo → (router) → parallelDispatch → [flights + hotels + weather in parallel]
 *         → entertainment → compilePlan → saveMemory → END
 *
 * Follow-up question path (after plan delivered):
 *   START → collectInfo → (router: "refine") → refinement → END
 */
const graph = new StateGraph(TravelState)
    .addNode("collectInfo",      collectInfoNode)
    .addNode("parallelDispatch", () => ({}))          // empty pass-through node that triggers the fan-out
    .addNode("searchFlights",    searchFlightsNode)
    .addNode("searchHotels",     searchHotelsNode)
    .addNode("searchWeather",    searchWeatherNode)
    .addNode("entertainment",    entertainmentNode)
    .addNode("compilePlan",      compilePlanNode)
    .addNode("saveMemory",       saveMemoryNode)       // runs after plan; saves to long-term store
    .addNode("refinement",       refinementNode)

    .addEdge(START, "collectInfo")

    // After collectInfo, call routeAfterCollect() to decide where to go next.
    // The object maps each possible return value to a node name.
    .addConditionalEdges("collectInfo", routeAfterCollect, {
        refine:   "refinement",
        proceed:  "parallelDispatch",
        [END]:    END,
    })

    // parallelDispatch calls dispatchSearches() which returns three Send objects,
    // launching all three search nodes simultaneously.
    .addConditionalEdges("parallelDispatch", dispatchSearches, [
        "searchFlights", "searchHotels", "searchWeather",
    ])

    // All three search nodes feed into entertainmentNode. LangGraph waits for all
    // three to finish before calling entertainmentNode (implicit join / barrier).
    .addEdge("searchFlights", "entertainment")
    .addEdge("searchHotels",  "entertainment")
    .addEdge("searchWeather", "entertainment")
    .addEdge("entertainment", "compilePlan")
    .addEdge("compilePlan",   "saveMemory")
    .addEdge("saveMemory",    END)
    .addEdge("refinement",    END);

/**
 * MongoDBSaver — SHORT-TERM / IN-THREAD memory (checkpoint persistence).
 *
 * Saves the full graph state (all TravelState fields) to MongoDB after every node runs.
 * Keyed by `thread_id` (one per plan). When `travelAgent.invoke()` is called with the
 * same thread_id, LangGraph reloads the last checkpoint and continues from where it left off.
 * This is what enables resuming a trip plan across process restarts.
 *
 * Collections used: `checkpoints` and `checkpoint_writes` (managed automatically).
 *
 * Cast needed: this project uses mongodb@7.x; the checkpoint package bundles mongodb@6.x
 * internally. The runtime is identical but TypeScript types diverge — `as any` bridges them.
 */
const checkpointer = new MongoDBSaver({
    client: mongoClient as any,
    dbName: process.env.MONGODB_DB!,
});

/**
 * MongoDBStore — LONG-TERM / CROSS-THREAD memory (user preferences + past trips).
 *
 * Unlike MongoDBSaver (which is scoped to one thread/plan), MongoDBStore is a
 * general-purpose key-value store shared across ALL plans and sessions. It stores:
 *   - User travel preferences (budget, seat, hotel stars, dietary)
 *   - Past trip summaries (destination, dates, highlights, recommended hotels)
 *   - Recurring travel companions (family member names and ages)
 *
 * Data is organized in namespaces: ["user", "default", "preferences"] and
 * ["user", "default", "trips"]. This is like folders in a file system.
 *
 * Exported so cli.ts can call memoryStore.start() (creates indexes) and .stop() (cleanup).
 *
 * Collection used: `long_term_memory` (separate from checkpoint collections).
 */
export const memoryStore = new MongoDBStore({
    client: mongoClient as any,
    dbName: process.env.MONGODB_DB!,
    collectionName: "long_term_memory",
} as any);

/**
 * graph.compile() locks the graph structure, attaches the checkpointer and memory store,
 * and returns a runnable agent. After this point:
 *   - `travelAgent.invoke(input, { configurable: { thread_id } })` runs the graph
 *   - `travelAgent.getState({ configurable: { thread_id } })` reads saved state
 * Both the checkpointer and store are injected into every node via the `config` argument.
 */
export const travelAgent = graph.compile({ checkpointer, store: memoryStore });
