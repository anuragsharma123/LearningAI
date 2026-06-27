import { travelAgent } from "../travelAgent.js";
import {
    loadPlanRegistry,
    savePlanEntry,
    deletePlanEntry,
    clearAllPlans,
    type PlanEntry,
} from "../db.js";

/**
 * PlanConfig is the shape LangGraph expects when you invoke the graph or read its state.
 * The `configurable` wrapper is LangGraph's convention — any runtime config (thread_id,
 * user_id, recursion limits, etc.) goes inside `configurable` so the graph can pass it
 * through to checkpointers and memory stores.
 */
export type PlanConfig = { configurable: { thread_id: string } };

/**
 * Module-level mutable state — these four variables track the current session.
 *
 * They are exported as `let` (not `const`) so that planManager functions can reassign them
 * and cli.ts can read their current values on each loop iteration. In JavaScript/TypeScript,
 * importing a `let` export gives you a live binding — reading `activePlanName` always returns
 * the current value, not a snapshot taken at import time. This is how we share mutable
 * session state across modules without a class or a global store.
 */

/** In-memory mirror of the `plan_registry` MongoDB collection. Loaded on startup. */
export let planRegistry = new Map<string, PlanEntry>();

/** Name of the plan the user is currently talking about, or null if none selected. */
export let activePlanName: string | null = null;

/**
 * LangGraph config for the active plan. Passed to `travelAgent.invoke()` and
 * `travelAgent.getState()` so LangGraph knows which thread_id to read/write.
 * Each plan gets a unique thread_id, so their states are completely isolated —
 * two plans for different destinations cannot interfere with each other.
 */
export let activeConfig: PlanConfig | null = null;

/**
 * Whether the final plan has been delivered to the user in this session.
 * Used by cli.ts to decide whether to show the plan output or just print the agent reply.
 * Resets to false when switching to a plan whose finalPlan is empty.
 */
export let planDelivered = false;

/**
 * Load all plans from MongoDB into the in-memory registry.
 * Called once at startup before the REPL loop begins.
 */
export async function initRegistry(): Promise<void> {
    planRegistry = await loadPlanRegistry();
}

/**
 * Create a brand-new plan with a unique thread_id and make it the active plan.
 *
 * `thread_id` is generated from Date.now() to guarantee uniqueness across sessions.
 * Each plan's entire conversation history, extracted trip details, and search results
 * are stored under this thread_id in MongoDB — completely isolated from other plans.
 */
export async function createPlan(name: string, description: string): Promise<void> {
    const threadId = `travel-${Date.now()}`;
    const entry: PlanEntry = { threadId, description };
    planRegistry.set(name, entry);
    await savePlanEntry(name, threadId, description);
    activePlanName = name;
    activeConfig = { configurable: { thread_id: threadId } };
    planDelivered = false;
    console.log(`\n[New plan] "${name}" — ${description}\n`);
}

/**
 * Switch the active plan to an existing one by name.
 *
 * Calls `travelAgent.getState()` to check whether this plan already has a compiled
 * finalPlan in its checkpoint. If it does, we set planDelivered = true so cli.ts
 * knows to skip re-printing the plan and go straight to the refinement prompt.
 *
 * Returns false if no plan with that name exists (so cli.ts can show an error).
 */
export async function switchPlan(name: string): Promise<boolean> {
    const entry = planRegistry.get(name);
    if (!entry) return false;
    activePlanName = name;
    activeConfig = { configurable: { thread_id: entry.threadId } };
    // Read the saved LangGraph checkpoint to determine current state of this plan
    const existing = await travelAgent.getState(activeConfig);
    planDelivered = !!existing.values?.finalPlan;
    console.log(`\n[Switched] "${name}" — ${entry.description}${planDelivered ? " (plan ready — ask follow-up questions)" : ""}\n`);
    return true;
}

/**
 * Delete a plan by name: removes it from the in-memory registry, MongoDB plan_registry,
 * and wipes its LangGraph checkpoint data (checkpoints + checkpoint_writes collections).
 * If the deleted plan was active, clears the active plan so the user starts fresh.
 */
export async function deletePlan(name: string): Promise<boolean> {
    const entry = planRegistry.get(name);
    if (!entry) return false;
    await deletePlanEntry(name, entry.threadId);
    planRegistry.delete(name);
    if (activePlanName === name) {
        activePlanName = null;
        activeConfig = null;
        planDelivered = false;
        console.log(`\n[Deleted] "${name}". No active plan.\n`);
    } else {
        console.log(`\n[Deleted] "${name}".\n`);
    }
    return true;
}

/**
 * Delete ALL plans: clears the in-memory registry, MongoDB plan_registry, and all
 * LangGraph checkpoint data for every thread_id. Long-term memories (long_term_memory
 * collection) are intentionally preserved — user preferences survive a full plan clear.
 */
export async function clearPlans(): Promise<void> {
    const threadIds = [...planRegistry.values()].map(e => e.threadId);
    await clearAllPlans(threadIds);
    planRegistry.clear();
    activePlanName = null;
    activeConfig = null;
    planDelivered = false;
    console.log("\n[Cleared] All plans removed.\n");
}

/** Print all saved plans with the active one marked. */
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
 * Directly set the active plan — used when resuming a plan from a CLI arg on startup,
 * bypassing the normal createPlan/switchPlan flow.
 */
export function setActivePlan(name: string, threadId: string, delivered: boolean): void {
    activePlanName = name;
    activeConfig = { configurable: { thread_id: threadId } };
    planDelivered = delivered;
}

/** Mark the active plan as having its final plan delivered to the user. */
export function setPlanDelivered(value: boolean): void {
    planDelivered = value;
}
