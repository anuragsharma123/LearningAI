import { tool } from "langchain";
import * as z from "zod";
import fetchTextFromUrl from "./fetchTextFromUrl.js";

const getWeather = tool(
    async ({ city, date }: { city: string; date: string }): Promise<string> => {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const result = await fetchTextFromUrl.invoke({ url });
        if (result.startsWith("Fetch")) {
            return `Weather unavailable for ${city} on ${date}. Error: ${result}`;
        }
        return result;
    },
    {
        name: "getWeather",
        description: "Get real weather forecast for a city around a given travel date. Returns JSON with temperature, precipitation, and conditions from wttr.in.",
        schema: z.object({
            city: z.string().describe("The city or destination to get weather for"),
            date: z.string().describe("Travel start date in YYYY-MM-DD format"),
        }),
    }
);

export default getWeather;
