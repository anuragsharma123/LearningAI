import { fetchTextFromUrl } from "./fetchTextFromUrl.js";

/**
 * getWeather — fetches JSON weather data from wttr.in for a city and date.
 *
 * In LangGraph this was a LangChain `tool()` object invoked via `.invoke(args)`.
 * Here it's a plain async function called directly from Promise.all() in runTravelAgent().
 *
 * Returns the raw wttr.in JSON string — compilePlan() and getEntertainment() both
 * read it to adapt plans and activity categories to actual weather conditions.
 *
 * On failure returns a plain error message; the model falls back to its knowledge
 * of typical weather for the destination.
 */
export async function getWeather(args: { city: string; date: string }): Promise<string> {
    const { city, date } = args;
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const result = await fetchTextFromUrl(url);
    if (result.startsWith("Fetch")) {
        return `Weather unavailable for ${city} on ${date}. Error: ${result}`;
    }
    return result;
}
