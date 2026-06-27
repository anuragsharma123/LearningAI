import readline from "node:readline";
import { HumanMessage } from "@langchain/core/messages";
import { travelAgent, memoryStore } from "./travelAgent.js";
import { startMongo, stopMongo, savePlanEntry } from "./db.js";
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
    return new Promise((resolve) => rl.question(prompt, resolve));
}

export async function main(): Promise<void> {
    await startMongo();
    await memoryStore.start();
    await initRegistry();

    console.log("=== Travel Planning Agent ===");
    console.log("Just describe your trip — I'll handle the rest.\n");

    // Handle CLI resume arg (npm start <threadId>)
    const resumeThreadId = process.argv[2] ?? null;
    if (resumeThreadId) {
        const existingEntry = [...planRegistry.entries()].find(([, e]) => e.threadId === resumeThreadId);
        const name = existingEntry?.[0] ?? "resumed";
        const description = existingEntry?.[1]?.description ?? "";
        if (!existingEntry) {
            planRegistry.set(name, { threadId: resumeThreadId, description });
            await savePlanEntry(name, resumeThreadId, description);
        }
        const existing = await travelAgent.getState({ configurable: { thread_id: resumeThreadId } });
        const delivered = !!existing.values?.finalPlan;
        setActivePlan(name, resumeThreadId, delivered);
        console.log(`Resumed: "${name}"${delivered ? " — plan already delivered. Ask follow-up questions." : ""}\n`);
    } else if (planRegistry.size > 0) {
        listPlans();
        console.log("Continue a trip above, or describe a new one.\n");
    }

    async function runAgent(message: string): Promise<void> {
        const cfg = activeConfig;
        if (!cfg) {
            console.log("\nJust describe a trip and I'll get started.\n");
            return;
        }

        const spinner = startSpinner(planDelivered ? "Thinking about your question..." : "Thinking...");
        let state;
        try {
            state = await travelAgent.invoke({ messages: [new HumanMessage(message)] }, cfg);
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

        const lastMessage = state.messages[state.messages.length - 1];
        const reply =
            typeof lastMessage?.content === "string"
                ? lastMessage.content
                : JSON.stringify(lastMessage?.content);
        console.log(`\nAgent: ${reply}\n`);
    }

    while (true) {
        const currentPlanName: string | null = activePlanName;
        const prompt = currentPlanName ? `[${currentPlanName}] You: ` : "You: ";
        const input = await ask(prompt);
        const trimmed = input.trim();
        if (trimmed === "") continue;

        const allPlans = [...planRegistry.entries()].map(([name, { description }]) => ({ name, description }));
        const activePlanCtx = currentPlanName
            ? { name: currentPlanName, description: planRegistry.get(currentPlanName)?.description ?? "" }
            : null;

        const decision = await classifyIntent(trimmed, activePlanCtx, allPlans);

        switch (decision.action) {
            case "exit":
                rl.close();
                await memoryStore.stop();
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
                const found = await deletePlan(target);
                if (!found) console.log(`\nCouldn't find a plan matching "${target}".\n`);
                break;
            }

            case "switch_plan": {
                const target = decision.planName ?? "";
                const found = await switchPlan(target);
                if (!found) {
                    console.log(`\nCouldn't find a plan matching "${target}".\n`);
                } else {
                    await runAgent(trimmed);
                }
                break;
            }

            case "new_plan": {
                const name = decision.suggestedName ?? `travel-${Date.now()}`;
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
