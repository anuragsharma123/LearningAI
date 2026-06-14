import { tool } from "langchain";
import * as z from "zod";
import fetchTextFromUrl from "./fetchTextFromUrl.js";

const searchEntertainment = tool(
    async ({ destination, weatherCondition, kidFriendly, categories }: {
        destination: string;
        weatherCondition: string;
        kidFriendly: boolean;
        categories: string[];
    }): Promise<string> => {
        const categoryQuery = categories.join(" ");
        const audienceQuery = kidFriendly ? "family kid-friendly activities" : "things to do activities";
        const query = `${audienceQuery} ${categoryQuery} ${destination}`;

        // TripAdvisor attractions search
        const url =
            `https://www.tripadvisor.com/Search?q=${encodeURIComponent(query)}` +
            `&geo=&searchSessionId=&sid=&blockRedirect=true`;

        const result = await fetchTextFromUrl.invoke({ url });

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
    },
    {
        name: "searchEntertainment",
        description:
            "Find entertainment, activities, and attractions at a destination. " +
            "Filters results by weather suitability (indoor vs outdoor) and age appropriateness " +
            "(kid-friendly when any group member is under 12). Returns up to 10 options " +
            "with name, category, description, and kid-friendly flag.",
        schema: z.object({
            destination: z.string().describe("City or region to find activities in"),
            weatherCondition: z.string().describe(
                "Weather during the trip, e.g. 'sunny and warm', 'rainy', 'cold and snowy'"
            ),
            kidFriendly: z.boolean().describe(
                "True if any group member is under 12 years old — enables family/kid-friendly filter"
            ),
            categories: z.array(z.string()).describe(
                "Activity categories to search, e.g. ['outdoor', 'museum', 'beach', 'indoor', 'adventure', 'cultural', 'food']"
            ),
        }),
    }
);

export default searchEntertainment;
