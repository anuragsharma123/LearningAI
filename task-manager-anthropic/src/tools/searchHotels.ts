import { fetchTextFromUrl } from "./fetchTextFromUrl.js";

/**
 * searchHotels — scrapes Booking.com for hotels at the destination.
 *
 * In LangGraph this was a LangChain `tool()` object invoked via `.invoke(args)`.
 * Here it's a plain async function called directly from runTravelAgent().
 *
 * Filters applied via URL: 3–5 star rating, free cancellation, sorted by value score.
 *
 * On scraping failure returns a fallback prompt so compilePlan() still receives
 * realistic hotel suggestions from the model's own knowledge.
 */
export async function searchHotels(args: {
    destination: string;
    checkIn: string;
    checkOut: string;
    memberCount: number;
}): Promise<string> {
    const { destination, checkIn, checkOut, memberCount } = args;
    const encodedDest = encodeURIComponent(destination);
    const url =
        `https://www.booking.com/searchresults.html` +
        `?ss=${encodedDest}` +
        `&checkin=${checkIn}` +
        `&checkout=${checkOut}` +
        `&group_adults=${memberCount}` +
        `&nflt=class%3D3%3Bclass%3D4%3Bclass%3D5%3Bfree_cancellation%3D1` +
        `&order=bayesian_review_score`;

    const result = await fetchTextFromUrl(url);

    if (result.startsWith("Fetch")) {
        return (
            `Hotel search via web scraping failed for ${destination} ` +
            `(check-in: ${checkIn}, check-out: ${checkOut}, ${memberCount} guest(s)). Error: ${result}\n` +
            `Please use your knowledge to suggest 5 realistic hotel options with ` +
            `name, star rating, approx price per night, free cancellation availability, ` +
            `and a value score (1-10 based on price vs quality).`
        );
    }

    return (
        `Hotel search results for ${destination} ` +
        `(${checkIn} to ${checkOut}, ${memberCount} guest(s)):\n\n` +
        result
    );
}
