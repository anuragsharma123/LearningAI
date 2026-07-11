import { fetchTextFromUrl } from "./fetchTextFromUrl.js";

/**
 * searchFlights — scrapes Kayak for round-trip flights between two cities.
 *
 * In LangGraph this was exported as a LangChain `tool()` object with a Zod schema,
 * and invoked via `searchFlights.invoke(args)`. Here it's a plain async function
 * invoked directly: `await searchFlights(args)`.
 *
 * Filters applied via URL: max 1 stop, sorted by price ascending.
 *
 * On scraping failure the function returns a prompt-style fallback string that
 * instructs the model to use its own knowledge — so the plan always has flight
 * options even when the scrape is blocked.
 */
export async function searchFlights(args: {
    origin: string;
    destination: string;
    startDate: string;
    returnDate: string;
    memberCount: number;
}): Promise<string> {
    const { origin, destination, startDate, returnDate, memberCount } = args;
    const url = `https://www.kayak.com/flights/${encodeURIComponent(origin)}-${encodeURIComponent(destination)}/${startDate}/${returnDate}/${memberCount}adults?sort=price_a&stops=~1&fs=stops=1`;

    const result = await fetchTextFromUrl(url);

    if (result.startsWith("Fetch")) {
        return (
            `Flight search via web scraping failed for ${origin} → ${destination} ` +
            `(${startDate} to ${returnDate}, ${memberCount} traveler(s)). Error: ${result}\n` +
            `Please use your knowledge to suggest 5 realistic flight options with ` +
            `airline, approx price, stops (max 1), cabin class, and typical flight duration.`
        );
    }

    return (
        `Flight search results for ${origin} → ${destination} ` +
        `(${startDate}–${returnDate}, ${memberCount} traveler(s)):\n\n` +
        result
    );
}
