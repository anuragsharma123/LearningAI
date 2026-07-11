# Plan: Travel Agent — Anthropic SDK (task-manager-claude)

## Context
The existing `LearningLangChart` project builds a travel agent on top of LangGraph + LangChain. The goal here is to rebuild the **same agent** in `task-manager-claude` using only the raw **Anthropic SDK** (`@anthropic-ai/sdk`) — no LangChain, no LangGraph. This is a learning exercise: each file will show what LangGraph was doing for you and what you must do yourself.

---

## Concept Map: LangGraph → Anthropic SDK

| LangGraph / LangChain | Raw Anthropic SDK Equivalent |
|---|---|
| `Annotation.Root()` typed state | Plain TypeScript `interface TravelState {}` |
| `StateGraph` + nodes + edges | `if/else` control flow in `travelAgent.ts` |
| `Send()` fan-out | `Promise.all([...])` |
| `routeAfterCollect` router node | `if (state.infoCollected)` in TypeScript |
| `MongoDBSaver` checkpointer | Manual: save/load `messages[]` + state to MongoDB |
| `MongoDBStore` cross-thread store | Same MongoDB collection, manual `get`/`put` helpers |
| `getStore(config)` inside a node | Pass `store` explicitly as a function argument |
| `initChatModel("claude-sonnet-4-6")` | `new Anthropic()` client + `client.messages.create()` |
| `model.bindTools([tool])` | Pass `tools: [...]` array in API call |
| `withStructuredOutput(ZodSchema)` | Force tool call: `tool_choice: { type: "tool", name: "..." }` |
| LangChain `tool()` wrapper | Inline Anthropic tool definition with JSON schema |
| `BaseMessage[]` / `HumanMessage` | `Anthropic.MessageParam[]` (`{ role, content }`) |
| `messagesStateReducer` | Manual `state.messages.push(...)` |

---

## File Structure

```
task-manager-claude/
├── package.json
├── tsconfig.json
├── .env                           ← ANTHROPIC_API_KEY, MONGODB_URI, MONGODB_DB
└── src/
    ├── index.ts                   ← 2-line entry: import { main } from "./cli.js"; main()
    ├── cli.ts                     ← REPL loop + plan management (mirrors LearningLangChart)
    ├── client.ts                  ← new Anthropic() singleton  (replaces model.ts)
    ├── state.ts                   ← TravelState interface      (replaces Annotation.Root)
    ├── db.ts                      ← MongoDB: conversation state + plan registry + long-term memory
    ├── travelAgent.ts             ← Orchestration loop          (replaces StateGraph)
    ├── nodes/
    │   ├── collectInfo.ts         ← Replaces collectInfoNode: forced tool call + memory retrieval
    │   ├── compilePlan.ts         ← Replaces compilePlanNode: markdown plan synthesis
    │   ├── saveMemory.ts          ← Replaces saveMemoryNode: extract + persist long-term memories
    │   └── refine.ts              ← Replaces refinementNode: follow-up Q&A
    ├── tools/
    │   ├── definitions.ts         ← All Anthropic tool JSON schemas in one place
    │   ├── fetchTextFromUrl.ts    ← Copy as-is (no LangChain dependency)
    │   ├── searchFlights.ts       ← Copy logic, remove tool() wrapper
    │   ├── searchHotels.ts        ← Same
    │   ├── getWeather.ts          ← Same
    │   └── searchEntertainment.ts ← Same
    ├── utils/
    │   ├── ui.ts                  ← Copy as-is (no changes needed)
    │   ├── planManager.ts         ← Same logic, adapted to new db.ts + state shape
    │   └── metaRouter.ts          ← Same logic, forced tool call instead of withStructuredOutput
    └── markdown/                  ← Copy all 4 .md prompts unchanged
```

---

## Implementation Steps

### Step 1 — Project Bootstrap
`package.json`: ES modules, `tsx` runner, only `@anthropic-ai/sdk`, `mongodb`, `dotenv` (remove all `@langchain/*`).
`tsconfig.json`: copy from LearningLangChart — same `nodenext` / `ES2022` config.
`.env`: copy `ANTHROPIC_API_KEY`, `MONGODB_URI`, `MONGODB_DB` from LearningLangChart.

---

### Step 2 — `src/client.ts` (replaces `model.ts`)

```typescript
import Anthropic from "@anthropic-ai/sdk";

// Single shared client instance — reads ANTHROPIC_API_KEY from process.env automatically.
// In LearningLangChart, initChatModel() created a LangChain wrapper around the same API.
// Here we talk to Anthropic directly — no wrapper layer.
export const anthropic = new Anthropic();

// Centralise the model name so we can change it in one place.
// In LearningLangChart this was the first arg to initChatModel().
export const MODEL = "claude-sonnet-4-6";
```

**Learning point**: No streaming wrapper, no `extractionModel` vs `model` split. We pass `stream: true` inline on calls that need it.

---

### Step 3 — `src/state.ts` (replaces LangGraph Annotation)

```typescript
import type Anthropic from "@anthropic-ai/sdk";

// TravelState is just a plain TypeScript interface — no Annotation.Root(), no reducers.
// In LangGraph, each field had a reducer function that controlled how node outputs merged
// into state. Here we mutate the object directly with Object.assign() or simple assignment.
export interface TravelState {
    // SDK's native message type replaces LangChain's BaseMessage / HumanMessage / AIMessage.
    // Same two fields: role ("user" | "assistant") and content (string or content block[]).
    messages: Anthropic.MessageParam[];

    // Trip details — populated by collectInfo() when the model returns a forced tool call.
    // In LangGraph these were Annotation fields with default: () => "" reducers.
    origin: string;
    destination: string;
    startDate: string;
    returnDate: string;
    members: { name: string; age: number | null }[];

    // Search results — populated in parallel by Promise.all() (replaces Send() fan-out).
    // In LangGraph, flightResults and hotelResults used the concat reducer so parallel
    // workers could each append their slice. Here we just set the full string directly.
    flightResults: string;
    hotelResults: string;
    weatherSummary: string;
    entertainmentOptions: string;

    // The finished markdown travel plan, set by compilePlan().
    finalPlan: string;

    // Gate flag: true once all required trip details have been collected.
    // Replaces LangGraph's routeAfterCollect conditional edge — we check this with if/else.
    infoCollected: boolean;

    // Persisted stage — "collecting" until the plan is compiled, then "planned".
    // Saved to MongoDB so the stage survives process restarts (same role as in LangGraph).
    conversationStage: "collecting" | "planned";

    // Long-term memory context retrieved from MongoDB and injected into the system prompt.
    // Replaces the retrievedMemories field in LangGraph state.ts.
    retrievedMemories: string;
}

// Returns a zero-valued TravelState for new plans.
// Replaces LangGraph's default: () => ... on each Annotation field.
export function emptyState(): TravelState {
    return {
        messages: [], origin: "", destination: "", startDate: "", returnDate: "",
        members: [], flightResults: "", hotelResults: "", weatherSummary: "",
        entertainmentOptions: "", finalPlan: "", infoCollected: false,
        conversationStage: "collecting", retrievedMemories: "",
    };
}
```

---

### Step 4 — `src/db.ts` (manual checkpointing — replaces MongoDBSaver + MongoDBStore)

MongoDB collections used by this project:

| Collection | Purpose | Who writes | Who reads |
|---|---|---|---|
| `plan_registry` | name → threadId + description | `savePlanEntry()` | `loadPlanRegistry()` |
| `conversation_state` | Full TravelState per thread | `saveState()` | `loadState()` |
| `long_term_memory` | Cross-session preferences + trip history | `putMemory()` | `searchMemory()` |

```typescript
// ── Short-term / per-thread state ────────────────────────────────────────────
// Replaces MongoDBSaver, which serialized LangGraph state automatically after every node.
// Here we call saveState() explicitly — once per runTravelAgent() call.

export async function saveState(threadId: string, state: TravelState): Promise<void> {
    // Upsert by threadId — if the plan was restarted, overwrite the previous checkpoint.
    await db().collection("conversation_state").updateOne(
        { threadId },
        { $set: { threadId, state, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
}

export async function loadState(threadId: string): Promise<TravelState | null> {
    // Returns null for brand-new plans — caller falls back to emptyState().
    // In LangGraph, getState() returned an empty snapshot (not null) for new threads.
    const doc = await db().collection("conversation_state").findOne({ threadId });
    return doc ? (doc.state as TravelState) : null;
}

// ── Long-term / cross-thread memory ──────────────────────────────────────────
// Replaces MongoDBStore (getStore / store.put / store.search).
// Same namespace design: ["user", "default", "preferences"] / ["user", "default", "trips"].
// We encode the namespace as a dot-joined string for the MongoDB _id field.

export async function putMemory(
    namespace: string[],  // e.g. ["user", "default", "preferences"]
    key: string,          // e.g. "travel_prefs"
    value: Record<string, unknown>
): Promise<void> {
    const ns = namespace.join(".");          // "user.default.preferences"
    await db().collection("long_term_memory").updateOne(
        { ns, key },
        { $set: { ns, key, value, updatedAt: new Date() } },
        { upsert: true }
    );
}

export async function getMemory(
    namespace: string[],
    key: string
): Promise<Record<string, unknown> | null> {
    const ns = namespace.join(".");
    const doc = await db().collection("long_term_memory").findOne({ ns, key });
    return doc ? (doc.value as Record<string, unknown>) : null;
}

export async function searchMemory(
    namespace: string[],
    limit = 10
): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
    const ns = namespace.join(".");
    // In LangGraph, store.search(namespace) queried by namespace prefix.
    // Here we use a simple exact match on the encoded namespace string.
    const docs = await db().collection("long_term_memory")
        .find({ ns })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
    return docs.map(d => ({ key: d.key as string, value: d.value as Record<string, unknown> }));
}
```

**Learning point**: MongoDBSaver serialised LangGraph state automatically after every node. Here you decide *when* and *what* to save. We save after every `runTravelAgent()` call and after memory writes.

---

### Step 5 — `src/tools/definitions.ts`

Define all tools as `Anthropic.Tool[]` using Anthropic's native JSON Schema format:

```typescript
// collectInfoTool forces the model to return structured trip details.
// In LangGraph, collectInfoNode used extractionModel.withStructuredOutput(TripDetailsSchema).
// withStructuredOutput compiled the Zod schema into a tool definition behind the scenes.
// Here we write the JSON schema explicitly — same end result, no magic.
export const collectInfoTool: Anthropic.Tool = {
    name: "extract_trip_details",
    description: "Extract structured trip information from the conversation",
    input_schema: {
        type: "object",
        properties: {
            // true = we have everything; false = ask followUpQuestion
            infoComplete: { type: "boolean" },
            origin: { type: "string" },
            destination: { type: "string" },
            startDate: { type: "string", description: "ISO 8601 date e.g. 2026-07-15" },
            returnDate: { type: "string" },
            members: {
                type: "array",
                items: {
                    type: "object",
                    properties: { name: { type: "string" }, age: { type: ["number", "null"] } },
                    required: ["name", "age"]
                }
            },
            // The question to ask if infoComplete is false
            followUpQuestion: { type: "string" }
        },
        required: ["infoComplete", "origin", "destination", "startDate", "returnDate", "members", "followUpQuestion"]
    }
};

// entertainmentTool is an agentic tool — the model decides when to call it.
// tool_choice is NOT forced here; Claude calls it if it judges a search is needed.
export const entertainmentTool: Anthropic.Tool = { name: "search_entertainment", /* ... */ };

// routerTool classifies user intent into one of 7 actions (same as metaRouter.ts).
export const routerTool: Anthropic.Tool = { name: "classify_intent", /* ... */ };

// memoryTool forces the model to return structured memories after a trip is compiled.
// In LangGraph, saveMemoryNode used extractionModel.withStructuredOutput(MemorySchema).
export const memoryTool: Anthropic.Tool = { name: "extract_memories", /* ... */ };
```

**Learning point**: LangChain's `tool()` wrapper + Zod schema generated this JSON for you. Here you write it directly — same API contract, no abstraction layer.

---

### Step 6 — `src/tools/*.ts` (remove LangChain wrappers)

Copy the 5 tool files from LearningLangChart. Remove the LangChain `tool()` wrapper — export plain async functions instead:

```typescript
// Before (LearningLangChart — LangChain wraps the function and attaches schema metadata):
export const searchFlights = tool(
    async ({ origin, destination, startDate, returnDate }) => { /* fetch logic */ },
    { name: "search_flights", schema: FlightSchema }
);

// After (task-manager-claude — plain async function, called directly by travelAgent.ts):
// The fetch logic inside is identical — only the export shape changes.
export async function searchFlights(args: {
    origin: string;
    destination: string;
    startDate: string;
    returnDate: string;
}): Promise<string> {
    /* same fetch logic, unchanged */
}
```

---

### Step 7 — `src/travelAgent.ts` (replaces StateGraph — the main conversion)

Replace the declarative graph with an imperative orchestration function:

```typescript
import { loadState, saveState } from "./db.js";
import { emptyState } from "./state.js";
import { collectInfo } from "./nodes/collectInfo.js";
import { compilePlan } from "./nodes/compilePlan.js";
import { saveMemory } from "./nodes/saveMemory.js";
import { refine } from "./nodes/refine.js";
import { searchFlights } from "./tools/searchFlights.js";
import { searchHotels } from "./tools/searchHotels.js";
import { getWeather } from "./tools/getWeather.js";
import { getEntertainment } from "./tools/searchEntertainment.js";

// runTravelAgent is the equivalent of travelAgent.invoke() in LearningLangChart.
// Instead of a StateGraph with declared nodes and edges, this function is the graph —
// each if/else branch is a conditional edge, each awaited call is a node.
export async function runTravelAgent(threadId: string, userMessage: string): Promise<TravelState> {

    // loadState() replaces MongoDBSaver's automatic checkpoint restore.
    // null = new plan → start from empty state (replaces LangGraph creating a fresh thread).
    const state = (await loadState(threadId)) ?? emptyState();

    // Append user message — replaces messagesStateReducer which merged HumanMessage into state.
    state.messages.push({ role: "user", content: userMessage });

    // ── Info collection gate ──────────────────────────────────────────────────
    // Replaces collectInfoNode + routeAfterCollect conditional edge in LangGraph.
    // routeAfterCollect returned "searches" or "collectInfo" based on infoCollected.
    if (!state.infoCollected) {
        const info = await collectInfo(state);   // forced tool call — see nodes/collectInfo.ts
        Object.assign(state, info);              // merge extracted fields into state

        if (!state.infoCollected) {
            // Model says it needs more info — send follow-up and wait for next message.
            // In LangGraph this was a graph edge back to the REPL (an implicit human-in-the-loop).
            state.messages.push({ role: "assistant", content: info.followUpQuestion });
            await saveState(threadId, state);    // persist so the question survives restart
            return state;
        }
    }

    // ── Main branch: first-time plan compilation ──────────────────────────────
    if (state.conversationStage === "collecting") {

        // Parallel searches — direct replacement for LangGraph's Send() fan-out.
        // Send() created a parallel dispatch node that LangGraph managed internally.
        // Promise.all() does the same thing — all three fetches run concurrently.
        const [flights, hotels, weather] = await Promise.all([
            searchFlights({ origin: state.origin, destination: state.destination, startDate: state.startDate, returnDate: state.returnDate }),
            searchHotels({ destination: state.destination, startDate: state.startDate, returnDate: state.returnDate, members: state.members }),
            getWeather({ city: state.destination, date: state.startDate }),
        ]);

        // Write results directly into state — replaces the concat reducer on flightResults/hotelResults.
        state.flightResults = flights;
        state.hotelResults = hotels;
        state.weatherSummary = weather;

        // Entertainment is agentic (model decides whether to call the tool) — sequential.
        // In LangGraph this was entertainmentNode, also run after the parallel searches.
        state.entertainmentOptions = await getEntertainment(state);

        // Synthesise all results into the final markdown plan — replaces compilePlanNode.
        state.finalPlan = await compilePlan(state);

        // Flip stage — same as setting conversationStage: "planned" in compilePlanNode.
        // Persisted so that after a restart, future messages route to refine() not re-search.
        state.conversationStage = "planned";

        // Save long-term memories — replaces saveMemoryNode which ran after compilePlanNode.
        await saveMemory(state);

    } else {
        // ── Refinement branch: follow-up Q&A on an existing plan ─────────────
        // Replaces refinementNode. Only reached after conversationStage flips to "planned".
        const answer = await refine(state);
        state.messages.push({ role: "assistant", content: answer });
    }

    // saveState() replaces MongoDBSaver's automatic checkpoint write after every node.
    // We save once per agent turn (not per node) — simpler, same recovery semantics.
    await saveState(threadId, state);
    return state;
}
```

---

### Step 8 — `src/nodes/collectInfo.ts` (replaces `collectInfoNode`)

```typescript
import { anthropic, MODEL } from "../client.js";
import { searchMemory, getMemory } from "../db.js";
import { collectInfoTool } from "../tools/definitions.js";
import type { TravelState } from "../state.js";

// collectInfo replaces collectInfoNode from LearningLangChart.
// Key differences:
//   - No config param (getStore is a LangGraph API; we pass db helpers directly)
//   - Memory retrieval uses our own searchMemory() / getMemory() instead of store.search()
//   - Forced tool call pattern is the same: tool_choice forces the model to return JSON
export async function collectInfo(state: TravelState): Promise<Partial<TravelState>> {

    // ── Retrieve long-term memories ───────────────────────────────────────────
    // Same logic as collectInfoNode.ts in LearningLangChart, but calling our own db helpers
    // instead of the LangGraph store API (getStore / store.search / store.get).
    let memoryContext = "";
    try {
        const [prefItems, tripItems, companionDoc] = await Promise.all([
            searchMemory(["user", "default", "preferences"]),   // replaces store.search(namespace, { limit: 1 })
            searchMemory(["user", "default", "trips"], 5),       // replaces store.search(namespace, { limit: 5 })
            getMemory(["user", "default", "preferences"], "companions"), // replaces store.get(namespace, key)
        ]);

        const prefs = prefItems.find(i => i.key === "travel_prefs")?.value;
        const companions = (companionDoc as any)?.members;
        const recentTrips = tripItems.filter(i => i.key !== "travel_prefs" && i.key !== "companions");

        const lines: string[] = [];
        if (prefs && Object.keys(prefs).length > 0) lines.push("Travel preferences: " + JSON.stringify(prefs));
        if (companions?.length > 0) lines.push("Recurring travel companions: " + JSON.stringify(companions));
        if (recentTrips.length > 0) lines.push("Past trips:\n" + recentTrips.map(t => `  - ${JSON.stringify(t.value)}`).join("\n"));
        if (lines.length > 0) memoryContext = "\n\n## What I already know about this traveler\n" + lines.join("\n");
    } catch { /* best-effort — never block trip planning */ }

    // ── Forced tool call to extract trip details ──────────────────────────────
    // tool_choice: { type: "tool", name: "extract_trip_details" } forces Claude to respond
    // with that specific tool call — equivalent to withStructuredOutput(TripDetailsSchema).
    // The model cannot return plain text here; it must fill the JSON schema.
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        tools: [collectInfoTool],
        tool_choice: { type: "tool", name: "extract_trip_details" }, // force — no free text
        system: COLLECT_INFO_SYSTEM_PROMPT + memoryContext,          // memory injected here
        messages: state.messages,
    });

    // The response content will always contain a tool_use block (because we forced it).
    // In LangGraph, withStructuredOutput parsed this block automatically.
    // Here we find it manually and cast its input to our expected shape.
    const toolUse = response.content.find(b => b.type === "tool_use");
    const info = toolUse?.input as {
        infoComplete: boolean;
        origin: string; destination: string;
        startDate: string; returnDate: string;
        members: { name: string; age: number | null }[];
        followUpQuestion: string;
    };

    // If infoComplete is false, only followUpQuestion matters — travelAgent.ts will
    // send it to the user and return, waiting for the next message.
    if (!info.infoComplete) {
        return { infoCollected: false, retrievedMemories: memoryContext };
    }

    return {
        origin: info.origin,
        destination: info.destination,
        startDate: info.startDate,
        returnDate: info.returnDate,
        members: info.members,
        infoCollected: true,           // flips the gate in travelAgent.ts
        retrievedMemories: memoryContext,
    };
}
```

---

### Step 9 — `src/nodes/saveMemory.ts` (replaces `saveMemoryNode`)

```typescript
import { anthropic, MODEL } from "../client.js";
import { putMemory } from "../db.js";
import { memoryTool } from "../tools/definitions.js";
import type { TravelState } from "../state.js";

// saveMemory replaces saveMemoryNode from LearningLangChart.
// Same two-phase pattern: (1) LLM extracts what to remember, (2) write to MongoDB.
// Key difference: no LangGraph store API — we call our own putMemory() from db.ts.
// Also no config param — no need for getStore() when db helpers are imported directly.
export async function saveMemory(state: TravelState): Promise<void> {

    // Guard: only save if a final plan was produced.
    // Same check as: if (!store || !state.finalPlan) return {} in LangGraph.
    if (!state.finalPlan) return;

    // ── LLM extraction ────────────────────────────────────────────────────────
    // Forced tool call replaces extractionModel.withStructuredOutput(MemorySchema).
    // The model must respond with the memoryTool JSON — no free text allowed.
    let extracted: {
        preferences: Record<string, string>;
        tripSummary: Record<string, unknown>;
        hasPreferences: boolean;
    };
    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1000,
            tools: [memoryTool],
            tool_choice: { type: "tool", name: "extract_memories" }, // force structured response
            system: MEMORY_EXTRACT_PROMPT,
            messages: [
                {
                    role: "user",
                    // Pass full conversation + plan so the model can extract facts from all of it.
                    // Same input as saveMemoryNode in LearningLangChart.
                    content: `Conversation:\n${state.messages.map(m => `${m.role}: ${m.content}`).join("\n\n")}\n\nFinal Plan:\n${state.finalPlan}`
                }
            ],
        });
        const toolUse = response.content.find(b => b.type === "tool_use");
        extracted = toolUse?.input as typeof extracted;
    } catch {
        return; // extraction failed — skip memory save, never crash the main flow
    }

    // ── Write to MongoDB ──────────────────────────────────────────────────────
    // Namespace design matches LearningLangChart exactly — same keys, same structure.
    // putMemory() does an upsert, so repeat trips accumulate without duplication.
    const tripKey = `${state.destination.toLowerCase().replace(/[\s,]+/g, "-")}-${state.startDate}`;

    const ops: Promise<void>[] = [
        // Always save the trip summary — even if no preferences were stated.
        putMemory(["user", "default", "trips"], tripKey, extracted.tripSummary),
    ];

    if (extracted.hasPreferences) {
        // Filter out empty/undefined preference fields before saving.
        const prefs = Object.fromEntries(
            Object.entries(extracted.preferences).filter(([, v]) => v !== undefined && v !== "")
        );
        // Upsert: overwrite previous preferences — last-write-wins per field.
        // In LangGraph this was store.put(["user","default","preferences"], "travel_prefs", prefs).
        ops.push(putMemory(["user", "default", "preferences"], "travel_prefs", prefs));
    }

    if (state.members.length > 0) {
        // Save companions list so future trips can pre-fill the travelers field.
        ops.push(putMemory(["user", "default", "preferences"], "companions", { members: state.members }));
    }

    await Promise.all(ops);
    console.log(`\n[Memory] Saved trip "${tripKey}" to long-term memory.\n`);
}
```

---

### Step 10 — `src/utils/metaRouter.ts`

Same classification logic as LearningLangChart, but replace `extractionModel.withStructuredOutput()` with a forced tool call:

```typescript
import { anthropic, MODEL } from "../client.js";
import { routerTool } from "../tools/definitions.js";

export async function classifyIntent(
    userMessage: string,
    activePlan: { name: string; description: string } | null,
    allPlans: Array<{ name: string; description: string }>
): Promise<RouterDecision> {

    // Build compact context string — identical to LearningLangChart's metaRouter.ts.
    // The model uses this to resolve "the Alaska trip" → actual plan key "alaska-jul15".
    const context = [
        activePlan ? `Active plan: "${activePlan.name}" — ${activePlan.description}` : "Active plan: none",
        allPlans.length > 0
            ? `All plans:\n${allPlans.map(p => `  - "${p.name}": ${p.description}`).join("\n")}`
            : "All plans: none saved yet",
        `User message: "${userMessage}"`,
    ].join("\n");

    // Forced tool call replaces extractionModel.withStructuredOutput(RouterSchema).
    // Same guarantee: model cannot return plain text — must fill the JSON schema.
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        tools: [routerTool],
        tool_choice: { type: "tool", name: "classify_intent" }, // force — same as withStructuredOutput
        system: ROUTER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
    });

    // Extract the tool_use block — withStructuredOutput did this automatically in LangGraph.
    const toolUse = response.content.find(b => b.type === "tool_use");
    return toolUse?.input as RouterDecision;
}
```

---

### Step 11 — `src/utils/planManager.ts` + `src/cli.ts`

Copy both files from LearningLangChart. Changes needed:

```typescript
// Before (LearningLangChart):
import { travelAgent } from "../travelAgent.js";
const state = await travelAgent.invoke({ messages: [new HumanMessage(msg)] }, activeConfig);
const existing = await travelAgent.getState(activeConfig);
const planDelivered = !!existing.values?.finalPlan;

// After (task-manager-claude):
import { runTravelAgent } from "../travelAgent.js";
import { loadState } from "../db.js";
// invoke → our imperative function, threadId extracted from config
const state = await runTravelAgent(threadId, message);
// getState → direct MongoDB load
const existing = await loadState(threadId);
const planDelivered = existing?.conversationStage === "planned";

// activeConfig shape changes — no LangGraph configurable wrapper needed:
// Before: { configurable: { thread_id: string } }
// After:  { threadId: string }
```

---

### Step 12 — `src/utils/ui.ts` + `src/markdown/`

Copy unchanged — no LangChain dependencies in either.

---

## Key Learning Points (Summary)

| What LangGraph gave you for free | What you write yourself in the SDK |
|---|---|
| Automatic state persistence after each node | `saveState()` called manually after each agent turn |
| Parallel fan-out via `Send()` | `Promise.all([...])` |
| Declarative routing via `addConditionalEdges()` | `if/else` in TypeScript |
| `withStructuredOutput(ZodSchema)` | `tool_choice: { type: "tool", name }` + read `tool_use` block |
| `model.bindTools()` + auto tool loop | Detect `stop_reason === "tool_use"`, call function, continue manually |
| `BaseMessage` + `messagesStateReducer` | Plain `MessageParam[]` + `array.push()` |
| Resume via `thread_id` in config | `loadState(threadId)` — same concept, you own the format |
| `MongoDBStore` + `getStore(config)` + namespaces | `putMemory()` / `searchMemory()` — plain MongoDB helpers |
| `store.put(namespace, key, value)` | `putMemory(["user","default","trips"], key, value)` |
| `store.search(namespace, { limit })` | `searchMemory(["user","default","trips"], limit)` |

---

## Verification
1. `npm install` in `task-manager-claude/`
2. `npm start` → describe a trip → agent collects info, runs parallel searches, delivers plan
3. Exit → `npm start` → plan appears in list → follow-up question works (refinement)
4. Describe a second trip → both plans tracked independently
5. Check MongoDB collections:
   - LearningLangChart: `checkpoints`, `checkpoint_writes` (managed by MongoDBSaver)
   - task-manager-claude: `conversation_state` (your own schema, you control it)
6. Check long-term memory flow:
   - First trip: verify `long_term_memory` collection has `travel_prefs`, `companions`, and a trip key
   - Second trip: verify `collectInfo()` system prompt includes the retrieved preferences block
   - Third trip (same destination): verify agent references past trip experience without being told
