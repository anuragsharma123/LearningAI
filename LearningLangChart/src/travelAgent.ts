import { StateGraph, START, END, Send, MemorySaver } from "@langchain/langgraph";
import { TravelState } from "./state.js";
import { collectInfoNode }    from "./nodes/collectInfoNode.js";
import { searchFlightsNode }  from "./nodes/searchFlightsNode.js";
import { searchHotelsNode }   from "./nodes/searchHotelsNode.js";
import { searchWeatherNode }  from "./nodes/searchWeatherNode.js";
import { entertainmentNode }  from "./nodes/entertainmentNode.js";
import { compilePlanNode }    from "./nodes/compilePlanNode.js";

// End the graph if details are still incomplete (user's next message will resume via checkpointer).
// Looping inside one invocation would cause the conversation to end on an AIMessage, which Claude rejects.
function routeAfterCollect(state: typeof TravelState.State): "proceed" | typeof END {
    return state.infoCollected ? "proceed" : END;
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
    .addNode("parallelDispatch", () => ({}))        // pass-through: only exists to be the Send source
    .addNode("searchFlights",    searchFlightsNode)
    .addNode("searchHotels",     searchHotelsNode)
    .addNode("searchWeather",    searchWeatherNode)
    .addNode("entertainment",    entertainmentNode)
    .addNode("compilePlan",      compilePlanNode)

    .addEdge(START, "collectInfo")

    // If info complete → fan out to searches; if incomplete → END so the user can reply
    .addConditionalEdges("collectInfo", routeAfterCollect, {
        proceed: "parallelDispatch",
        [END]:    END,
    })

    // Fan out to three parallel searches
    .addConditionalEdges("parallelDispatch", dispatchSearches, [
        "searchFlights", "searchHotels", "searchWeather",
    ])

    // All three converge at entertainment (LangGraph's built-in barrier)
    .addEdge("searchFlights", "entertainment")
    .addEdge("searchHotels",  "entertainment")
    .addEdge("searchWeather", "entertainment")
    .addEdge("entertainment", "compilePlan")
    .addEdge("compilePlan",   END);

export const travelAgent = graph.compile({ checkpointer: new MemorySaver() });
