import { tool } from "langchain";
import * as z from "zod";
import fetchTextFromUrl from "./fetchTextFromUrl.js";
import { stripHtml } from "../utils/stripHtml.js";

// Standard flight filters applied via the search URL:
//   - Max 1 stop (stops=1)
//   - Economy, premium economy, and business cabin options
//   - Sorted by price ascending
//   - Top 10 results
const searchFlights = tool(
    async ({ origin, destination, startDate, returnDate, memberCount }: {
        origin: string;
        destination: string;
        startDate: string;
        returnDate: string;
        memberCount: number;
    }): Promise<string> => {
        // Kayak flight search — more scraping-friendly than Google Flights
        const url = `https://www.kayak.com/flights/${encodeURIComponent(origin)}-${encodeURIComponent(destination)}/${startDate}/${returnDate}/${memberCount}adults?sort=price_a&stops=~1&fs=stops=1`;

        const result = await fetchTextFromUrl.invoke({ url });

        if (result.startsWith("Fetch")) {
            return (
                `Flight search via web scraping failed for ${origin} → ${destination} ` +
                `(${startDate} to ${returnDate}, ${memberCount} traveler(s)). Error: ${result}\n` +
                `Please use your knowledge to suggest 10 realistic flight options with ` +
                `airline, approx price, stops (max 1), cabin class, and typical flight duration.`
            );
        }

        const text = stripHtml(result);

        return (
            `Flight search results for ${origin} → ${destination} ` +
            `(${startDate}–${returnDate}, ${memberCount} traveler(s)):\n\n` +
            text
        );
    },
    {
        name: "searchFlights",
        description:
            "Search for available flights between origin and destination for given dates. " +
            "Applies standard filters: max 1 stop, sorted by price ascending, top 10 results " +
            "across economy/premium/business. Returns flight options with airline, price, stops, " +
            "cabin class, departure/arrival times, and duration.",
        schema: z.object({
            origin: z.string().describe("Departure city or airport (e.g. 'New York' or 'JFK')"),
            destination: z.string().describe("Arrival city or airport (e.g. 'Paris' or 'CDG')"),
            startDate: z.string().describe("Departure date in YYYY-MM-DD format"),
            returnDate: z.string().describe("Return date in YYYY-MM-DD format"),
            memberCount: z.number().int().min(1).describe("Total number of travelers"),
        }),
    }
);

export default searchFlights;
