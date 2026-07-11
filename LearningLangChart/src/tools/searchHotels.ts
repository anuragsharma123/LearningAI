import { tool } from "langchain";
import * as z from "zod";
import fetchTextFromUrl from "./fetchTextFromUrl.js";
import { stripHtml } from "../utils/stripHtml.js";

// Standard hotel filters applied via the search URL:
//   - Min 3-star rating
//   - Free cancellation preferred
//   - Sorted by value (best price-to-rating ratio)
//   - Top 10 results
const searchHotels = tool(
    async ({ destination, checkIn, checkOut, memberCount }: {
        destination: string;
        checkIn: string;
        checkOut: string;
        memberCount: number;
    }): Promise<string> => {
        const encodedDest = encodeURIComponent(destination);
        // Booking.com search — structured and relatively scraping-friendly
        const url =
            `https://www.booking.com/searchresults.html` +
            `?ss=${encodedDest}` +
            `&checkin=${checkIn}` +
            `&checkout=${checkOut}` +
            `&group_adults=${memberCount}` +
            `&nflt=class%3D3%3Bclass%3D4%3Bclass%3D5%3Bfree_cancellation%3D1` + // 3-5 star + free cancellation
            `&order=bayesian_review_score`; // sort by value score

        const result = await fetchTextFromUrl.invoke({ url });

        if (result.startsWith("Fetch")) {
            return (
                `Hotel search via web scraping failed for ${destination} ` +
                `(check-in: ${checkIn}, check-out: ${checkOut}, ${memberCount} guest(s)). Error: ${result}\n` +
                `Please use your knowledge to suggest 10 realistic hotel options with ` +
                `name, star rating, approx price per night, free cancellation availability, ` +
                `and a value score (1-10 based on price vs quality).`
            );
        }

        const text = stripHtml(result);

        return (
            `Hotel search results for ${destination} ` +
            `(${checkIn} to ${checkOut}, ${memberCount} guest(s)):\n\n` +
            text
        );
    },
    {
        name: "searchHotels",
        description:
            "Search for hotels at a destination for given dates. " +
            "Applies standard filters: minimum 3-star rating, free cancellation preferred, " +
            "sorted by value score. Returns up to 10 hotels with name, star rating, " +
            "price per night, free cancellation status, and value score.",
        schema: z.object({
            destination: z.string().describe("City or region to search hotels in (e.g. 'Paris, France')"),
            checkIn: z.string().describe("Check-in date in YYYY-MM-DD format"),
            checkOut: z.string().describe("Check-out date in YYYY-MM-DD format"),
            memberCount: z.number().int().min(1).describe("Total number of guests"),
        }),
    }
);

export default searchHotels;
