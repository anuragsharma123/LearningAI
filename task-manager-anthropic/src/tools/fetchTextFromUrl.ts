/**
 * fetchTextFromUrl — fetches raw HTML/text from a URL with a 30-second timeout.
 *
 * In LangGraph this was wrapped in `tool(fn, { name, schema })` so LangChain could
 * invoke it via model.bindTools(). Here it's a plain async function — tools are
 * just functions now. The calling code (searchFlights, searchHotels, etc.) calls
 * this directly without any framework in between.
 *
 * Returns an error string (starting with "Fetch") instead of throwing so callers
 * can detect failure and fall back to asking the model to use its own knowledge.
 */
export async function fetchTextFromUrl(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; quickstart-research/1.0)",
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            return `Fetch failed: HTTP ${response.status} ${response.statusText}`;
        }
        return await response.text();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Fetch error: ${msg}`;
    } finally {
        clearTimeout(timeoutId);
    }
}
