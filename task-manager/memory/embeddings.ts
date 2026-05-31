/**
 * Local embedding generation using @xenova/transformers.
 *
 * Model: all-MiniLM-L6-v2 (~23 MB, downloaded once and cached in ~/.cache/huggingface)
 * Produces 384-dimensional vectors. Runs entirely on-device — no API key needed.
 *
 * The pipeline is lazy-loaded and cached so subsequent calls are fast.
 */

// @xenova/transformers uses a dynamic import style for ESM compatibility.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipe: any = null;

/**
 * Returns the singleton embedding pipeline, initialising it on first call.
 * Prints a one-time message while the model loads.
 */
async function getPipeline() {
  if (!_pipe) {
    // Dynamic import keeps the heavy model out of the startup path.
    const { pipeline, env } = await import("@xenova/transformers");

    // Cache models in the project's node_modules cache dir instead of ~/.cache
    env.cacheDir = "./.model-cache";

    process.stdout.write("  [Memory] Loading embedding model (first run only)... ");
    _pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true  // smaller + faster, minimal quality loss
    });
    console.log("done");
  }
  return _pipe;
}

/**
 * Converts a text string into a 384-dimensional embedding vector.
 * Uses mean pooling + L2 normalisation (standard for sentence similarity).
 *
 * @param text - The text to embed (task title, email subject, etc.)
 * @returns A normalised float32 array of length 384.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data) as number[];
}

/**
 * Computes cosine similarity between two vectors.
 * Both vectors must have the same length and be L2-normalised
 * (which `embed()` guarantees), so this reduces to a dot product.
 *
 * @returns A value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * b[i], 0);
}
