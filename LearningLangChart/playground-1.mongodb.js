/* global use, db */
// Travel Agent — MongoDB Playground
// Run this AFTER starting the app at least once (npm start)
// Make sure your Atlas cluster is selected as the active connection in the sidebar

use('travel_agent');

// ── 1. See all saved checkpoints (one per conversation turn) ──────────────────
const allCheckpoints = db.getCollection('checkpoints').find({}).toArray();
console.log('Total checkpoints:', allCheckpoints.length);

// ── 2. Inspect the latest checkpoint ─────────────────────────────────────────
const latest = db.getCollection('checkpoints')
  .find({})
  .sort({ 'checkpoint.ts': -1 })
  .limit(1)
  .toArray();
console.log('Latest checkpoint:', JSON.stringify(latest, null, 2));

// ── 3. See all thread IDs (one per session) ───────────────────────────────────
db.getCollection('checkpoints').distinct('thread_id');

// ── 4. See pending writes (in-flight state between steps) ─────────────────────
db.getCollection('checkpoint_writes').find({}).limit(5).toArray();
