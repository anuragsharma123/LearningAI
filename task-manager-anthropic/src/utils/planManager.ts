import { loadState } from "../db.js";
import {
    loadPlanRegistry,
    savePlanEntry,
    deletePlanEntry,
    clearAllPlans,
    type PlanEntry,
} from "../db.js";

/**
 * PlanConfig — the active plan's identity, passed to runTravelAgent().
 *
 * Replaces LangGraph's `{ configurable: { thread_id: string } }`.
 * LangGraph required the `configurable` wrapper because its checkpointer,
 * memory store, and recursion limit all lived inside that config object.
 * Here the only thing we need is a threadId string — no framework config needed.
 */
export type PlanConfig = { threadId: string };

/**
 * Module-level mutable session state — four variables that track what's active.
 *
 * Exported as `let` so cli.ts reads the current value on every loop iteration.
 * JavaScript `let` exports are live bindings — reading `activePlanName` from
 * another module always returns the latest value, not a snapshot from import time.
 * This is how we share mutable state across modules without a class or global store.
 */

/** In-memory mirror of the `plan_registry` MongoDB collection. Loaded on startup. */
export let planRegistry = new Map<string, PlanEntry>();

/** Name of the plan the user is currently talking about, or null if none selected. */
export let activePlanName: string | null = null;

/**
 * Active plan config passed to runTravelAgent().
 * Replaces: `{ configurable: { thread_id: string } }` from LangGraph.
 * Each plan has a unique threadId so their MongoDB state documents are isolated.
 */
export let activeConfig: PlanConfig | null = null;

/**
 * Whether the final plan has been delivered to the user in this session.
 * cli.ts uses this to decide whether to print the plan or just show the agent reply.
 * Resets to false when switching to a plan that has no finalPlan yet.
 */
export let planDelivered = false;

/**
 * initRegistry — loads all plans from MongoDB into the in-memory Map.
 * Called once at startup before the REPL loop begins.
 */
export async function initRegistry(): Promise<void> {
    planRegistry = await loadPlanRegistry();
}

/**
 * createPlan — creates a brand-new plan with a unique threadId and makes it active.
 *
 * The threadId is generated from Date.now() to guarantee uniqueness across sessions.
 * Every plan's conversation history, trip details, and search results are stored under
 * this threadId in `conversation_state` — completely isolated from other plans.
 */
export async function createPlan(name: string, description: string): Promise<void> {
    const threadId = `travel-${Date.now()}`;
    const entry: PlanEntry = { threadId, description };
    planRegistry.set(name, entry);
    await savePlanEntry(name, threadId, description);
    activePlanName = name;
    activeConfig   = { threadId };
    planDelivered  = false;
    console.log(`\n[New plan] "${name}" — ${description}\n`);
}

/**
 * switchPlan — switches the active plan to an existing one by name.
 *
 * Calls loadState() (replaces `travelAgent.getState({ configurable: { thread_id } })`)
 * to check whether this plan already has a compiled finalPlan. If it does, planDelivered
 * is set to true so cli.ts skips re-printing the plan and goes to the refinement prompt.
 *
 * Returns false if no plan with that name exists — cli.ts shows an error.
 */
export async function switchPlan(name: string): Promise<boolean> {
    const entry = planRegistry.get(name);
    if (!entry) return false;
    activePlanName = name;
    activeConfig   = { threadId: entry.threadId };
    const existing = await loadState(entry.threadId);
    planDelivered  = !!existing?.finalPlan;
    console.log(`\n[Switched] "${name}" — ${entry.description}${planDelivered ? " (plan ready — ask follow-up questions)" : ""}\n`);
    return true;
}

/**
 * deletePlan — removes a plan from the registry and wipes its conversation_state document.
 * If the deleted plan was active, clears all active* variables so the user starts fresh.
 */
export async function deletePlan(name: string): Promise<boolean> {
    const entry = planRegistry.get(name);
    if (!entry) return false;
    await deletePlanEntry(name, entry.threadId);
    planRegistry.delete(name);
    if (activePlanName === name) {
        activePlanName = null;
        activeConfig   = null;
        planDelivered  = false;
        console.log(`\n[Deleted] "${name}". No active plan.\n`);
    } else {
        console.log(`\n[Deleted] "${name}".\n`);
    }
    return true;
}

/**
 * clearPlans — deletes ALL plans from registry and conversation_state.
 * Unlike LearningLangChart, there is no long_term_memory collection to preserve.
 */
export async function clearPlans(): Promise<void> {
    const threadIds = [...planRegistry.values()].map(e => e.threadId);
    await clearAllPlans(threadIds);
    planRegistry.clear();
    activePlanName = null;
    activeConfig   = null;
    planDelivered  = false;
    console.log("\n[Cleared] All plans removed.\n");
}

/** listPlans — prints all saved plans to stdout with the active one marked. */
export function listPlans(): void {
    if (planRegistry.size === 0) {
        console.log("\nNo plans yet — just describe a trip and I'll create one.\n");
        return;
    }
    console.log("\nYour travel plans:");
    for (const [name, { description }] of planRegistry) {
        const marker = name === activePlanName ? " ← active" : "";
        console.log(`  ${name.padEnd(24)} ${description}${marker}`);
    }
    console.log();
}

/**
 * setActivePlan — directly sets the active plan variables.
 * Used on startup when resuming a plan from a CLI arg (npm start <threadId>),
 * bypassing the normal createPlan/switchPlan flow.
 */
export function setActivePlan(name: string, threadId: string, delivered: boolean): void {
    activePlanName = name;
    activeConfig   = { threadId };
    planDelivered  = delivered;
}

/** setPlanDelivered — marks the active plan as having its finalPlan printed to the user. */
export function setPlanDelivered(value: boolean): void {
    planDelivered = value;
}
