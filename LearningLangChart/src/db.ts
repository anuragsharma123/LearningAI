import { MongoClient } from "mongodb";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A single shared MongoClient instance for the whole application.
 * The client is created at module load time but NOT yet connected — `startMongo()` calls
 * `mongoClient.connect()`. All other modules import this client and use it lazily;
 * they just need `startMongo()` to have been called first.
 *
 * This project uses THREE separate MongoDB collections, each with a distinct purpose:
 *   - `checkpoints`       — LangGraph short-term memory (full graph state per thread_id).
 *                           Managed automatically by MongoDBSaver; do not write to it manually.
 *   - `checkpoint_writes` — LangGraph incremental node writes (internal to MongoDBSaver).
 *   - `plan_registry`     — App-level metadata: name → { threadId, description } mapping.
 *                           Used by planManager to list and resume named trips.
 *   - `long_term_memory`  — Cross-session user memory (preferences, past trips, companions).
 *                           Written by saveMemoryNode, read by collectInfoNode.
 */
export const mongoClient = new MongoClient(process.env.MONGODB_URI!);

/** PID of the mongod child process we spawned, if any. Used to kill it on exit. */
let spawnedPid: number | null = null;

/** Probe port 27017 — resolve true if mongod is already running, false otherwise. */
function isMongodRunning(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port: 27017 });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
    });
}

/** Poll until mongod accepts connections or the timeout elapses. */
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
 * Starts MongoDB and connects the shared client.
 *
 * If mongod is already running (e.g. launched externally or by a previous session),
 * it is left alone. Otherwise a new mongod process is spawned as a detached child
 * so it can outlive the parent if needed (though we kill it on exit via stopMongo).
 *
 * `detached: true` + `child.unref()` means Node.js won't keep the event loop alive
 * waiting for mongod to exit — the app can shut down cleanly and mongod keeps running
 * or is killed explicitly via its PID.
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
 * Closes the client connection and kills the mongod process we spawned.
 * Only kills mongod if WE started it — if it was already running on app launch,
 * we leave it running so other tools aren't affected.
 */
export async function stopMongo(): Promise<void> {
    await mongoClient.close();
    if (spawnedPid !== null) {
        process.kill(spawnedPid, "SIGTERM");
        console.log("MongoDB stopped.");
    }
}

// ── Plan Registry (persisted in MongoDB) ─────────────────────────────────────
// The plan registry maps human-readable plan names ("alaska-jul15") to their
// LangGraph thread_id ("travel-1718000000000") and a short description.
// It lives in `plan_registry` collection — separate from LangGraph's checkpoints.

/** Shorthand accessor for the travel_agent database. */
function db() { return mongoClient.db(process.env.MONGODB_DB!); }

/** Each plan entry pairs a LangGraph thread_id with a human-readable description. */
export type PlanEntry = { threadId: string; description: string };

/**
 * Load all saved plans from MongoDB into an in-memory Map.
 * Called once on startup by planManager.initRegistry().
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
 * Upsert a plan entry by name. Called when creating a new plan or updating its description.
 * `$setOnInsert` ensures `createdAt` is only written on first insert, not on updates.
 */
export async function savePlanEntry(name: string, threadId: string, description = ""): Promise<void> {
    await db().collection("plan_registry").updateOne(
        { name },
        { $set: { name, threadId, description, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
}

/**
 * Delete a plan from the registry AND wipe its LangGraph checkpoint data.
 * Deleting from checkpoints/checkpoint_writes frees storage and ensures the thread_id
 * can't be accidentally resumed after deletion.
 */
export async function deletePlanEntry(name: string, threadId: string): Promise<void> {
    await db().collection("plan_registry").deleteOne({ name });
    await db().collection("checkpoints").deleteMany({ thread_id: threadId });
    await db().collection("checkpoint_writes").deleteMany({ thread_id: threadId });
}

/**
 * Wipe all plans: clears the registry and all checkpoint data for the provided thread IDs.
 * The `long_term_memory` collection is intentionally NOT cleared — user preferences and
 * past trip summaries persist even when individual plans are deleted.
 */
export async function clearAllPlans(threadIds: string[]): Promise<void> {
    await db().collection("plan_registry").deleteMany({});
    if (threadIds.length > 0) {
        await db().collection("checkpoints").deleteMany({ thread_id: { $in: threadIds } });
        await db().collection("checkpoint_writes").deleteMany({ thread_id: { $in: threadIds } });
    }
}
