import { fetchTextFromUrl } from "./fetchTextFromUrl.js";

/**
 * searchEntertainment — scrapes TripAdvisor for activities at the destination.
 *
 * In LangGraph this was a LangChain `tool()` object that `entertainmentNode` called
 * via `model.bindTools([searchEntertainment])` — the model decided to call it and
 * LangChain executed it. Here it's a plain async function that getEntertainment()
 * calls after detecting `stop_reason === "tool_use"` in the API response.
 *
 * The search query is built from weather conditions and the kid-friendly flag —
 * rainy weather → more indoor categories; children present → kidFriendly: true.
 *
 * On scraping failure the fallback string asks the model to use its own knowledge
 * for the same categories, so the output is never empty.
 */
export async function searchEntertainment(args: {
    destination: string;
    weatherCondition: string;
    kidFriendly: boolean;
    categories: string[];
}): Promise<string> {
    const { destination, weatherCondition, kidFriendly, categories } = args;
    const categoryQuery = categories.join(" ");
    const audienceQuery = kidFriendly ? "family kid-friendly activities" : "things to do activities";
    const query = `${audienceQuery} ${categoryQuery} ${destination}`;

    const url =
        `https://www.tripadvisor.com/Search?q=${encodeURIComponent(query)}` +
        `&geo=&searchSessionId=&sid=&blockRedirect=true`;

    const result = await fetchTextFromUrl(url);

    const context =
        `Destination: ${destination}\n` +
        `Weather: ${weatherCondition}\n` +
        `Kid-friendly filter: ${kidFriendly}\n` +
        `Categories searched: ${categoryQuery}\n\n`;

    if (result.startsWith("Fetch")) {
        return (
            context +
            `Entertainment search via web scraping failed. Error: ${result}\n` +
            `Please use your knowledge to suggest 10 ${kidFriendly ? "family and kid-friendly " : ""}` +
            `activities and attractions in ${destination} suited to ${weatherCondition} weather. ` +
            `Include a mix of: ${categoryQuery}. ` +
            `For each, provide name, category, brief description, and whether it is kid-friendly.`
        );
    }

    return context + result;
}
