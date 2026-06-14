import { tool } from "langchain";
import * as z from "zod";


const fetchTextFromUrl = tool(
    async ({url}:{url: string}) :Promise<string> => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);
        try {
                const response = await fetch(url,{
                    headers: {
                        "User-Agent": "Mozilla/5.0 (compatible; quickstart-research/1.0)",
                        },
                        signal: controller.signal,
                });
                if (!response.ok) {
                        return `Fetch failed: HTTP ${response.status} ${response.statusText}`;
                    }
                const text = await response.text();
                return text;
        }catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return `Fetch error: ${msg}`;
        }finally {          
            clearTimeout(timeoutId);
        }
    },
    {
        name: "fetchTextFromUrl",
        description: "Fetch text content from a URL.",
        schema: z.object({
            url: z.string().describe("The URL to fetch text from"),
        }),
    }
);

export default fetchTextFromUrl;