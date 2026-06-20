import { travelAgent } from "../travelAgent.js";
import {
    loadPlanRegistry,
    savePlanEntry,
    deletePlanEntry,
    clearAllPlans,
    type PlanEntry,
} from "../db.js";

export type PlanConfig = { configurable: { thread_id: string } };

export let planRegistry = new Map<string, PlanEntry>();
export let activePlanName: string | null = null;
export let activeConfig: PlanConfig | null = null;
export let planDelivered = false;

export async function initRegistry(): Promise<void> {
    planRegistry = await loadPlanRegistry();
}

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

export async function switchPlan(name: string): Promise<boolean> {
    const entry = planRegistry.get(name);
    if (!entry) return false;
    activePlanName = name;
    activeConfig = { configurable: { thread_id: entry.threadId } };
    const existing = await travelAgent.getState(activeConfig);
    planDelivered = !!existing.values?.finalPlan;
    console.log(`\n[Switched] "${name}" — ${entry.description}${planDelivered ? " (plan ready — ask follow-up questions)" : ""}\n`);
    return true;
}

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

export async function clearPlans(): Promise<void> {
    const threadIds = [...planRegistry.values()].map(e => e.threadId);
    await clearAllPlans(threadIds);
    planRegistry.clear();
    activePlanName = null;
    activeConfig = null;
    planDelivered = false;
    console.log("\n[Cleared] All plans removed.\n");
}

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

export function setActivePlan(name: string, threadId: string, delivered: boolean): void {
    activePlanName = name;
    activeConfig = { configurable: { thread_id: threadId } };
    planDelivered = delivered;
}

export function setPlanDelivered(value: boolean): void {
    planDelivered = value;
}
