import readline from "node:readline";
import { runTravelAgent } from "./travelAgent.js";
import { startMongo, stopMongo, savePlanEntry, loadState } from "./db.js";
import { startSpinner, stopSpinner } from "./utils/ui.js";
import {
    initRegistry,
    createPlan,
    switchPlan,
    deletePlan,
    clearPlans,
    listPlans,
    setActivePlan,
    setPlanDelivered,
    planRegistry,
    activePlanName,
    activeConfig,
    planDelivered,
} from "./utils/planManager.js";
import { classifyIntent } from "./utils/metaRouter.js";

/**
 * readline interface — provides the interactive REPL loop.
 * `input: process.stdin, output: process.stdout` wires up keyboard input and terminal output.
 * The interface is closed in the "exit" case to allow Node.js to exit cleanly.
 */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** ask — wraps rl.question in a Promise so we can await it in the REPL loop. */
function ask(prompt: string): Promise<string> {
    return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * main — top-level entry point for the CLI.
 *
 * Startup sequence:
 *   1. startMongo() — connects to MongoDB (spawning mongod if needed).
 *   2. initRegistry() — loads saved plans from plan_registry into memory.
 *   3. Optional: resume a specific plan passed as `npm start <threadId>`.
 *   4. REPL loop: read user input → classifyIntent() → dispatch to action handler.
 *
 * Differences from LearningLangChart:
 *   - No `memoryStore.start()` / `memoryStore.stop()` — long-term memory not ported.
 *   - `travelAgent.invoke()` → `runTravelAgent(threadId, message)`.
 *   - `travelAgent.getState()` → `loadState(threadId)`.
 *   - `activeConfig` is `{ threadId }` not `{ configurable: { thread_id } }`.
 *   - `new HumanMessage(message)` → plain string passed directly to runTravelAgent.
 */
export async function main(): Promise<void> {
    await startMongo();
    await initRegistry();

    console.log("=== Travel Planning Agent (Anthropic SDK) ===");
    console.log("Just describe your trip — I'll handle the rest.\n");

    // Handle CLI resume arg: `npm start <threadId>` skips the normal plan selection flow.
    const resumeThreadId = process.argv[2] ?? null;
    if (resumeThreadId) {
        const existingEntry = [...planRegistry.entries()].find(([, e]) => e.threadId === resumeThreadId);
        const name        = existingEntry?.[0] ?? "resumed";
        const description = existingEntry?.[1]?.description ?? "";
        if (!existingEntry) {
            planRegistry.set(name, { threadId: resumeThreadId, description });
            await savePlanEntry(name, resumeThreadId, description);
        }
        // loadState replaces: travelAgent.getState({ configurable: { thread_id } })
        const existing  = await loadState(resumeThreadId);
        const delivered = !!existing?.finalPlan;
        setActivePlan(name, resumeThreadId, delivered);
        console.log(`Resumed: "${name}"${delivered ? " — plan already delivered. Ask follow-up questions." : ""}\n`);
    } else if (planRegistry.size > 0) {
        listPlans();
        console.log("Continue a trip above, or describe a new one.\n");
    }

    /**
     * runAgent — sends the user's message to the travel agent and prints the result.
     *
     * The spinner runs during the API call (can take 10–60s for a full plan).
     * After the call:
     *   - If this is the first time finalPlan appears, print it and mark planDelivered.
     *   - Otherwise print the last assistant message (a follow-up question or refinement).
     *
     * `planDelivered` is read from the module-level let — reading it here always gives
     * the current value because JavaScript `let` exports are live bindings.
     */
    async function runAgent(message: string): Promise<void> {
        const cfg = activeConfig;
        if (!cfg) {
            console.log("\nJust describe a trip and I'll get started.\n");
            return;
        }

        const spinner = startSpinner(planDelivered ? "Thinking about your question..." : "Thinking...");
        let state;
        try {
            // Replaces: travelAgent.invoke({ messages: [new HumanMessage(message)] }, cfg)
            // No HumanMessage wrapper needed — Anthropic.MessageParam uses plain strings.
            state = await runTravelAgent(cfg.threadId, message);
        } finally {
            stopSpinner(spinner);
        }

        if (state.finalPlan && !planDelivered) {
            setPlanDelivered(true);
            console.log(`\n--- Travel Plan: "${activePlanName}" ---\n`);
            console.log(state.finalPlan);
            console.log("\n(Plan saved. Just ask any follow-up questions or describe a new trip.)\n");
            return;
        }

        // Print the last assistant message — either a follow-up question (collecting stage)
        // or a refinement answer (planned stage).
        const lastMessage = state.messages[state.messages.length - 1];
        const reply =
            typeof lastMessage?.content === "string"
                ? lastMessage.content
                : JSON.stringify(lastMessage?.content);
        console.log(`\nAgent: ${reply}\n`);
    }

    // ── REPL loop ─────────────────────────────────────────────────────────────
    // Every user message is first classified by classifyIntent() (the meta-router),
    // then dispatched to the appropriate handler. The travel agent only runs for
    // "continue", "new_plan", and "switch_plan" actions — the rest are local commands.
    while (true) {
        const currentPlanName: string | null = activePlanName;
        const prompt = currentPlanName ? `[${currentPlanName}] You: ` : "You: ";
        const input  = await ask(prompt);
        const trimmed = input.trim();
        if (trimmed === "") continue;

        const allPlans = [...planRegistry.entries()].map(([name, { description }]) => ({ name, description }));
        const activePlanCtx = currentPlanName
            ? { name: currentPlanName, description: planRegistry.get(currentPlanName)?.description ?? "" }
            : null;

        // classifyIntent() calls the API every turn to route the message.
        // This is cheap (max_tokens: 500) — it's the meta-layer above the agent.
        const decision = await classifyIntent(trimmed, activePlanCtx, allPlans);

        switch (decision.action) {
            case "exit":
                rl.close();
                await stopMongo();
                console.log("\nSession ended. Your plans are saved — run 'npm start' to continue.\n");
                return;

            case "list_plans":
                listPlans();
                break;

            case "clear_all":
                await clearPlans();
                break;

            case "delete_plan": {
                const target = decision.planName ?? "";
                const found  = await deletePlan(target);
                if (!found) console.log(`\nCouldn't find a plan matching "${target}".\n`);
                break;
            }

            case "switch_plan": {
                const target = decision.planName ?? "";
                const found  = await switchPlan(target);
                if (!found) {
                    console.log(`\nCouldn't find a plan matching "${target}".\n`);
                } else {
                    await runAgent(trimmed);
                }
                break;
            }

            case "new_plan": {
                const name        = decision.suggestedName ?? `travel-${Date.now()}`;
                const description = decision.description ?? "";
                await createPlan(name, description);
                await runAgent(trimmed);
                break;
            }

            case "continue":
                await runAgent(trimmed);
                break;
        }
    }
}
