import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { TravelState } from "./state.js";
import { mongoClient } from "./db.js";
import { collectInfoNode }   from "./nodes/collectInfoNode.js";
import { searchFlightsNode } from "./nodes/searchFlightsNode.js";
import { searchHotelsNode }  from "./nodes/searchHotelsNode.js";
import { searchWeatherNode } from "./nodes/searchWeatherNode.js";
import { entertainmentNode } from "./nodes/entertainmentNode.js";
import { compilePlanNode }   from "./nodes/compilePlanNode.js";
import { refinementNode }    from "./nodes/refinementNode.js";

// Three-way router:
//   "refine"  — plan already delivered, this is a follow-up question
//   "proceed" — all trip info collected, ready to search
//   END       — waiting for user to provide missing info
function routeAfterCollect(
    state: typeof TravelState.State
): "refine" | "proceed" | typeof END {
    if (state.conversationStage === "planned") return "refine";
    if (state.infoCollected) return "proceed";
    return END;
}

// Fan out three parallel searches via Send — LangGraph waits for all before advancing
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

const graph = new StateGraph(TravelState)
    .addNode("collectInfo",      collectInfoNode)
    .addNode("parallelDispatch", () => ({}))
    .addNode("searchFlights",    searchFlightsNode)
    .addNode("searchHotels",     searchHotelsNode)
    .addNode("searchWeather",    searchWeatherNode)
    .addNode("entertainment",    entertainmentNode)
    .addNode("compilePlan",      compilePlanNode)
    .addNode("refinement",       refinementNode)

    .addEdge(START, "collectInfo")

    .addConditionalEdges("collectInfo", routeAfterCollect, {
        refine:   "refinement",
        proceed:  "parallelDispatch",
        [END]:    END,
    })

    .addConditionalEdges("parallelDispatch", dispatchSearches, [
        "searchFlights", "searchHotels", "searchWeather",
    ])

    .addEdge("searchFlights", "entertainment")
    .addEdge("searchHotels",  "entertainment")
    .addEdge("searchWeather", "entertainment")
    .addEdge("entertainment", "compilePlan")
    .addEdge("compilePlan",   END)
    .addEdge("refinement",    END);

// MongoDB checkpointer — durable across process restarts, keyed by thread_id
// Cast needed: top-level mongodb@7.x vs checkpoint's bundled mongodb@6.x — same runtime, different TS types
const checkpointer = new MongoDBSaver({
    client: mongoClient as any,
    dbName: process.env.MONGODB_DB!,
});

// uses in-memory saver by default, which is not durable across restarts — good for testing
// export const travelAgent = graph.compile({ new MemorySaver() });

export const travelAgent = graph.compile({ checkpointer });
