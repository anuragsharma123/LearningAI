import { MongoClient } from "mongodb";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const mongoClient = new MongoClient(process.env.MONGODB_URI!);

let spawnedPid: number | null = null;

function isMongodRunning(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port: 27017 });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
    });
}

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

export async function stopMongo(): Promise<void> {
    await mongoClient.close();
    if (spawnedPid !== null) {
        process.kill(spawnedPid, "SIGTERM");
        console.log("MongoDB stopped.");
    }
}

// ── Plan Registry (persisted in MongoDB) ─────────────────────────────────────

function db() { return mongoClient.db(process.env.MONGODB_DB!); }

export type PlanEntry = { threadId: string; description: string };

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

export async function savePlanEntry(name: string, threadId: string, description = ""): Promise<void> {
    await db().collection("plan_registry").updateOne(
        { name },
        { $set: { name, threadId, description, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
}

export async function deletePlanEntry(name: string, threadId: string): Promise<void> {
    await db().collection("plan_registry").deleteOne({ name });
    await db().collection("checkpoints").deleteMany({ thread_id: threadId });
    await db().collection("checkpoint_writes").deleteMany({ thread_id: threadId });
}

export async function clearAllPlans(threadIds: string[]): Promise<void> {
    await db().collection("plan_registry").deleteMany({});
    if (threadIds.length > 0) {
        await db().collection("checkpoints").deleteMany({ thread_id: { $in: threadIds } });
        await db().collection("checkpoint_writes").deleteMany({ thread_id: { $in: threadIds } });
    }
}
