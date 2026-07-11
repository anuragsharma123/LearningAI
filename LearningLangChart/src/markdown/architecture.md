# LearningLangChart — Architecture & Flow

Four diagrams covering: overall system components, per-message request flow, the LangGraph node graph, and the memory architecture.

---

## 1. System Component Overview

High-level: what exists, what owns what, how the layers connect.

```mermaid
graph TB
    subgraph User["User (Terminal)"]
        INPUT[/"User types a message"/]
    end

    subgraph CLI["CLI Layer — cli.ts + planManager.ts"]
        REPL["REPL Loop\n(readline)"]
        PM["planManager.ts\nactivePlanName / activeConfig\ncreatePlan / switchPlan / deletePlan"]
        MR["metaRouter.ts\nclassifyIntent()\n→ new_plan / switch_plan / continue / exit …"]
    end

    subgraph Agent["LangGraph Agent — travelAgent.ts"]
        GRAPH["StateGraph\n(compiled with checkpointer + store)"]
    end

    subgraph Nodes["Graph Nodes"]
        N1["collectInfoNode\n— extract trip details\n— retrieve long-term memories"]
        N2["parallelDispatch\n— Send() fan-out"]
        N3["searchFlightsNode"]
        N4["searchHotelsNode"]
        N5["getWeatherNode"]
        N6["entertainmentNode\n(agentic tool call)"]
        N7["compilePlanNode\n— synthesise final plan\n— set conversationStage = planned"]
        N8["saveMemoryNode\n— extract preferences\n— write to MongoDBStore"]
        N9["refinementNode\n— answer follow-up Q&A"]
    end

    subgraph DB["MongoDB"]
        COL1[("checkpoints\ncheckpoint_writes\n— LangGraph short-term memory\n— per thread_id, auto-managed")]
        COL2[("plan_registry\n— name → threadId + description\n— app-managed")]
        COL3[("long_term_memory\n— preferences, past trips, companions\n— cross-session, cross-plan")]
    end

    subgraph Models["Anthropic Claude"]
        M1["model — claude-sonnet-4-6\n(streaming, 7k tokens)\n— used by compilePlanNode"]
        M2["extractionModel — claude-haiku-4-5\n(non-streaming, 2k tokens)\n— used by withStructuredOutput nodes"]
    end

    INPUT --> REPL
    REPL --> MR
    MR --> PM
    PM --> GRAPH
    GRAPH --> N1
    N1 --> N2
    N2 --> N3 & N4 & N5
    N3 & N4 & N5 --> N6
    N6 --> N7
    N7 --> N8
    N8 --> END(["END"])
    N1 -->|"conversationStage = planned"| N9
    N9 --> END

    GRAPH <-->|"MongoDBSaver\n(auto checkpoint)"| COL1
    PM <-->|"savePlanEntry / loadPlanRegistry"| COL2
    N8 -->|"store.put()"| COL3
    N1 <-->|"store.search() / store.get()"| COL3

    N1 & N7 & N8 & N9 --> M2
    N7 --> M1
```

---

## 2. Per-Message Request Flow

What happens step by step from the moment the user presses Enter to the moment the agent replies.

```mermaid
sequenceDiagram
    actor User
    participant CLI as cli.ts (REPL)
    participant MR as metaRouter.ts
    participant PM as planManager.ts
    participant AG as travelAgent.invoke()
    participant LG as LangGraph StateGraph
    participant DB as MongoDB

    User->>CLI: types a message
    CLI->>MR: classifyIntent(message, activePlan, allPlans)
    MR-->>CLI: RouterDecision { action, planName?, suggestedName? }

    alt action = new_plan
        CLI->>PM: createPlan(name, description)
        PM->>DB: savePlanEntry() → plan_registry
        PM-->>CLI: activeConfig set
        CLI->>AG: invoke({ messages: [HumanMessage] }, activeConfig)
    else action = switch_plan
        CLI->>PM: switchPlan(name)
        PM->>AG: getState(config) → check finalPlan
        PM-->>CLI: activeConfig set, planDelivered flag set
        CLI->>AG: invoke({ messages: [HumanMessage] }, activeConfig)
    else action = continue
        CLI->>AG: invoke({ messages: [HumanMessage] }, activeConfig)
    else action = list_plans / delete_plan / clear_all / exit
        CLI->>PM: listPlans() / deletePlan() / clearPlans()
        PM->>DB: update plan_registry
    end

    AG->>LG: run graph (see Diagram 3)
    LG-->>AG: TravelState with finalPlan or reply message
    AG->>DB: MongoDBSaver checkpoints state automatically

    alt finalPlan is new
        AG-->>CLI: state.finalPlan
        CLI-->>User: prints plan + "ask follow-up questions"
    else refinement reply
        AG-->>CLI: last message content
        CLI-->>User: prints Agent: reply
    end
```

---

## 3. LangGraph Node Graph

The internal graph structure: nodes, edges, and conditional routing.

```mermaid
flowchart TD
    START(["__start__"])
    CI["collectInfoNode\n\n1. Retrieve long-term memories\n   store.search preferences + trips\n2. withStructuredOutput → TripDetailsSchema\n3. Returns: trip fields + retrievedMemories\n   OR followUpQuestion if info incomplete"]
    ROUTE{"routeAfterCollect\n\nif infoCollected = false\n  → collectInfo again\nif conversationStage = planned\n  → refinement\nelse\n  → parallelDispatch"}
    PD["parallelDispatch\n\nSend() fan-out:\ncreates 3 parallel branches,\none per search worker"]
    SF["searchFlightsNode\n\nfetchTextFromUrl → stripHtml(3k chars)\nAppends to flightResults"]
    SH["searchHotelsNode\n\nfetchTextFromUrl → stripHtml(3k chars)\nAppends to hotelResults"]
    GW["getWeatherNode\n\nWebSearch + fetchTextFromUrl\nSets weatherSummary"]
    EN["entertainmentNode\n\nAgentic: model decides\nwhether to call searchEntertainment tool\nSets entertainmentOptions"]
    CP["compilePlanNode\n\nmodel (streaming, 7k tokens)\nSynthesises all results → markdown plan\nSets: finalPlan\nFlips: conversationStage = planned\nAdds plan to messages[]"]
    SM["saveMemoryNode\n\nwithStructuredOutput → MemorySchema\nExtracts: preferences + tripSummary\nWrites to MongoDBStore:\n  preferences/travel_prefs\n  preferences/companions\n  trips/destination-startDate"]
    RN["refinementNode\n\nmodel (streaming)\nAnswers follow-up Q&A using\nthe plan already in messages[]"]
    END(["__end__"])

    START --> CI
    CI --> ROUTE
    ROUTE -->|"infoCollected = false"| CI
    ROUTE -->|"stage = collecting"| PD
    ROUTE -->|"stage = planned"| RN
    PD -->|"Send(searchFlights, …)"| SF
    PD -->|"Send(searchHotels, …)"| SH
    PD -->|"Send(getWeather, …)"| GW
    SF & SH & GW --> EN
    EN --> CP
    CP --> SM
    SM --> END
    RN --> END

    style CI fill:#dbeafe,stroke:#3b82f6
    style CP fill:#dbeafe,stroke:#3b82f6
    style SM fill:#dcfce7,stroke:#16a34a
    style RN fill:#fef9c3,stroke:#ca8a04
    style ROUTE fill:#fce7f3,stroke:#db2777
    style PD fill:#ede9fe,stroke:#7c3aed
    style SF fill:#ede9fe,stroke:#7c3aed
    style SH fill:#ede9fe,stroke:#7c3aed
    style GW fill:#ede9fe,stroke:#7c3aed
    style EN fill:#ede9fe,stroke:#7c3aed
```

---

## 4. Memory Architecture

Three distinct memory layers and how data flows between them.

```mermaid
flowchart LR
    subgraph ShortTerm["Short-Term Memory (per plan)"]
        direction TB
        MS["MongoDBSaver\n(checkpointer)"]
        COL1[("MongoDB\ncheckpoints\ncheckpoint_writes")]
        MS <-->|"auto-save after every node\nauto-restore on next invoke()\nkeyed by thread_id"| COL1
    end

    subgraph LongTerm["Long-Term Memory (cross-plan, cross-session)"]
        direction TB
        STORE["MongoDBStore\n(store)"]
        COL3[("MongoDB\nlong_term_memory")]
        STORE <-->|"store.put() / store.search()\nkeyed by namespace + key"| COL3
    end

    subgraph PlanMeta["Plan Registry (app metadata)"]
        direction TB
        PM["planManager.ts"]
        COL2[("MongoDB\nplan_registry")]
        PM <-->|"savePlanEntry / loadPlanRegistry\nkeyed by plan name"| COL2
    end

    subgraph Namespaces["MongoDBStore Namespace Schema"]
        direction TB
        NS1["['user','default','preferences']\n  key: 'travel_prefs'\n  → { seating, budget_usd,\n      hotel_stars, travel_style,\n      dietary, flight_preference }"]
        NS2["['user','default','preferences']\n  key: 'companions'\n  → { members: [{name, age}, …] }"]
        NS3["['user','default','trips']\n  key: 'alaska-2026-07-15'\n  → { destination, startDate,\n      returnDate, members,\n      highlights, hotelRecommended }"]
    end

    subgraph Nodes["Graph Nodes that touch memory"]
        CI["collectInfoNode\nREADS long-term memory\n→ injects into system prompt"]
        SM["saveMemoryNode\nWRITES long-term memory\n→ after plan is compiled"]
        CP["compilePlanNode\nREADS MongoDBSaver checkpoint\n→ flips conversationStage = planned"]
    end

    CI -->|"store.search(preferences)\nstore.search(trips)\nstore.get(companions)"| STORE
    SM -->|"store.put(trips, key, summary)\nstore.put(preferences, travel_prefs, …)\nstore.put(preferences, companions, …)"| STORE
    STORE --> Namespaces
    CP -->|"state restored automatically\nby MongoDBSaver"| MS

    classDef membox fill:#dbeafe,stroke:#3b82f6
    classDef ltmbox fill:#dcfce7,stroke:#16a34a
    classDef metabox fill:#fef9c3,stroke:#ca8a04
    class ShortTerm membox
    class LongTerm ltmbox
    class PlanMeta metabox
```

---

## 5. Scaffolding: File Responsibility Map

Which file owns which concern.

```mermaid
graph LR
    subgraph Entry["Entry & REPL"]
        IDX["index.ts\n2-line entry point"]
        CLI["cli.ts\nREPL loop\nspin / print logic\nrunAgent() helper"]
    end

    subgraph Routing["Intent Routing"]
        MR["metaRouter.ts\nclassifyIntent()\nwithStructuredOutput → RouterSchema\n7 possible actions"]
        PM["planManager.ts\ncreatePlan / switchPlan\ndeletePlan / clearPlans\nlistPlans / setPlanDelivered\nlive let exports (active state)"]
    end

    subgraph Graph["Agent Graph"]
        TA["travelAgent.ts\nStateGraph definition\nnode wiring\nconditional edges\nMongoDBSaver + MongoDBStore\nexport: travelAgent, memoryStore"]
        ST["state.ts\nAnnotation.Root()\nTravelState schema\nreducers for each field"]
    end

    subgraph NodeFiles["Node Files"]
        CIN["collectInfoNode.ts\ninfo extraction\nmemory retrieval"]
        SMN["saveMemoryNode.ts\nmemory extraction\nMongoDBStore writes"]
        CPN["compilePlanNode.ts\nplan synthesis\nstage flip"]
        RFN["refinementNode.ts\nfollow-up Q&A"]
        PDN["parallelDispatchNode.ts\nSend() fan-out"]
        SFN["searchFlightsNode.ts"]
        SHN["searchHotelsNode.ts"]
        GWN["getWeatherNode.ts"]
        EN["entertainmentNode.ts\nagentic tool call"]
    end

    subgraph Infra["Infrastructure"]
        DB["db.ts\nmongoClient singleton\nstartMongo / stopMongo\nplan registry CRUD\nMongoDBSaver init"]
        MDL["model.ts\nmodel — sonnet-4-6 (streaming, 7k)\nextractionModel — haiku-4-5 (non-streaming, 2k)"]
        UI["utils/ui.ts\nstartSpinner / stopSpinner"]
        SH2["utils/stripHtml.ts\nstripHtml(html, maxChars=3000)\n— used by search tools"]
    end

    subgraph Prompts["Markdown Prompts"]
        P1["travel-system-prompt.md"]
        P2["compile-plan-prompt.md"]
        P3["refinement-prompt.md"]
        P4["entertainment-prompt.md"]
        P5["weather-system-prompt.md"]
        P6["fetchTextFromUrl-system-prompt.md"]
    end

    IDX --> CLI
    CLI --> MR & PM
    PM --> TA
    TA --> ST
    TA --> CIN & SMN & CPN & RFN & PDN
    PDN --> SFN & SHN & GWN & EN
    CIN & SMN --> MDL
    CPN & RFN --> MDL
    DB --> TA & PM
    SFN & SHN --> SH2
    CPN --> P2
    RFN --> P3
    EN --> P4
```
