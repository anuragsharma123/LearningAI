import { MongoClient } from "mongodb";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TravelState } from "./state.js";

/**
 * mongoClient — a single shared MongoClient for the whole application.
 * Created at module load time but not connected until startMongo() is called.
 *
 * This project uses TWO MongoDB collections (much simpler than LangGraph):
 *   - `conversation_state` — your own checkpoint format: { threadId, state, updatedAt }.
 *                            Replaces LangGraph's `checkpoints` + `checkpoint_writes` managed by MongoDBSaver.
 *   - `plan_registry`     — name → { threadId, description } mapping, same as LearningLangChart.
 *
 * LangGraph's MongoDBSaver wrote to checkpoints after EVERY node run automatically.
 * Here you control exactly when state is saved by calling saveState() manually.
 */
export const mongoClient = new MongoClient(process.env.MONGODB_URI!);

/** PID of the mongod child process we spawned, if any. Used to kill it on exit. */
let spawnedPid: number | null = null;

/** Probe port 27017 — returns true if mongod is already accepting connections. */
function isMongodRunning(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port: 27017 });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
    });
}

/** Poll every 200 ms until mongod accepts connections or the timeout elapses. */
function waitForMongod(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = async () => {
            if (await isMongodRunning()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error("mongod did not start within 10s"));
            setTimeout(poll, 200);
        };
        poll();
    });
}

/**
 * startMongo — starts MongoDB and connects the shared client.
 *
 * If mongod is already running (e.g. launched externally) it's left alone.
 * Otherwise a new mongod is spawned as a detached child so it can survive the
 * parent process if needed. `child.unref()` prevents Node from keeping the
 * event loop alive waiting for mongod to exit.
 */
export async function startMongo(): Promise<void> {
    if (await isMongodRunning()) {
        console.log("MongoDB already running.");
    } else {
        const dbPath = process.env.MONGODB_DBPATH ?? join(homedir(), "data", "db");
        console.log(`Starting mongod (dbpath: ${dbPath})...`);
        const child = spawn("mongod", ["--dbpath", dbPath], {
            detached: true,
            stdio: "ignore",
        });
        spawnedPid = child.pid ?? null;
        child.unref();
        await waitForMongod();
        console.log("MongoDB started.");
    }
    await mongoClient.connect();
}

/**
 * stopMongo — closes the client and kills mongod only if we spawned it.
 * If it was already running when the app launched, we leave it running
 * so other tools that depend on it aren't affected.
 */
export async function stopMongo(): Promise<void> {
    await mongoClient.close();
    if (spawnedPid !== null) {
        process.kill(spawnedPid, "SIGTERM");
        console.log("MongoDB stopped.");
    }
}

/** Shorthand accessor for the travel_agent_sdk database. */
function db() { return mongoClient.db(process.env.MONGODB_DB!); }

// ── Conversation State (manual checkpointing) ─────────────────────────────────
//
// This is the direct replacement for LangGraph's MongoDBSaver.
//
// LangGraph's MongoDBSaver serialised the full graph state automatically after
// every node run, storing it in `checkpoints` and `checkpoint_writes` collections
// with its own internal format. You had no control over when saves happened.
//
// Here we save to `conversation_state` in our own format — just the TravelState
// object — and we decide when to call saveState() (once at the end of each
// runTravelAgent() call, or early when returning a follow-up question).

/**
 * saveState — persists the full TravelState for a threadId.
 * Upserts so the first call creates the document and subsequent calls update it.
 * Called manually at the end of runTravelAgent() (replaces MongoDBSaver auto-save).
 */
export async function saveState(threadId: string, state: TravelState): Promise<void> {
    await db().collection("conversation_state").updateOne(
        { threadId },
        { $set: { threadId, state, updatedAt: new Date() } },
        { upsert: true }
    );
}

/**
 * loadState — retrieves the saved TravelState for a threadId, or null if none exists.
 * Called at the start of runTravelAgent() to resume a prior session.
 * Replaces: `travelAgent.getState({ configurable: { thread_id } })` from LangGraph.
 */
export async function loadState(threadId: string): Promise<TravelState | null> {
    const doc = await db().collection("conversation_state").findOne({ threadId });
    return doc ? (doc.state as TravelState) : null;
}

// ── Plan Registry ──────────────────────────────────────────────────────────────
// Maps human-readable plan names ("alaska-jul15") to their threadId and description.
// Identical purpose to LearningLangChart — only the checkpoint cleanup differs
// (we delete from conversation_state instead of checkpoints/checkpoint_writes).

/** Each plan entry pairs a threadId with a human-readable description. */
export type PlanEntry = { threadId: string; description: string };

/**
 * loadPlanRegistry — loads all saved plans from MongoDB into a Map.
 * Called once at startup by planManager.initRegistry().
 */
export async function loadPlanRegistry(): Promise<Map<string, PlanEntry>> {
    const docs = await db().collection("plan_registry").find({}).toArray();
    const map = new Map<string, PlanEntry>();
    for (const doc of docs) {
        map.set(doc.name as string, {
            threadId: doc.threadId as string,
            description: (doc.description as string) ?? "",
        });
    }
    return map;
}

/**
 * savePlanEntry — upserts a plan by name.
 * `$setOnInsert` writes createdAt only on first insert, not on updates.
 */
export async function savePlanEntry(name: string, threadId: string, description = ""): Promise<void> {
    await db().collection("plan_registry").updateOne(
        { name },
        { $set: { name, threadId, description, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
}

/**
 * deletePlanEntry — removes a plan from the registry and wipes its conversation state.
 * Replaces LangGraph's version which deleted from checkpoints/checkpoint_writes collections.
 */
export async function deletePlanEntry(name: string, threadId: string): Promise<void> {
    await db().collection("plan_registry").deleteOne({ name });
    await db().collection("conversation_state").deleteOne({ threadId });
}

/**
 * clearAllPlans — wipes the registry and all conversation state documents.
 * Unlike LangGraph's version, there is no long_term_memory collection to preserve
 * (long-term memory was not ported to this SDK version).
 */
export async function clearAllPlans(threadIds: string[]): Promise<void> {
    await db().collection("plan_registry").deleteMany({});
    if (threadIds.length > 0) {
        await db().collection("conversation_state").deleteMany({ threadId: { $in: threadIds } });
    }
}
