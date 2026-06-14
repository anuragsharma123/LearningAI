import { AIMessage, SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TravelState, type TravelMember } from "../state.js";
import { extractionModel } from "../model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, "../markdown/travel-system-prompt.md"),
    "utf-8"
);

const TripDetailsSchema = z.object({
    infoComplete: z.boolean().describe(
        "True only when all 5 fields (origin, destination, startDate, returnDate, members with no null ages) are present"
    ),
    origin: z.string().describe("Departure city or airport — never omit, default to 'Not specified' if unknown"),
    destination: z.string().describe("Travel destination city and country"),
    startDate: z.string().describe("Departure date in YYYY-MM-DD format"),
    returnDate: z.string().describe(
        "Return date in YYYY-MM-DD format — calculate from startDate + duration if user gave number of days"
    ),
    members: z
        .array(
            z.object({
                name: z.string().describe("Auto-generate as adult_1, child_1, etc. if not given"),
                age: z.number().nullable().describe("Age as a number; null only when child age is truly unspecified"),
            })
        )
        .describe("All travelers with names and ages"),
    followUpQuestion: z.string().describe(
        "Required when infoComplete is false: one consolidated question for ALL missing info. Empty string when infoComplete is true."
    ),
});

export async function collectInfoNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    const structured = extractionModel.withStructuredOutput(TripDetailsSchema);

    const response = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        ...state.messages,
    ]);

    const hasUnknownAges = response.members?.some((m) => m.age === null) ?? false;

    if (
        response.infoComplete &&
        !hasUnknownAges &&
        response.origin &&
        response.destination &&
        response.startDate &&
        response.returnDate &&
        response.members?.length
    ) {
        return {
            origin: response.origin,
            destination: response.destination,
            startDate: response.startDate,
            returnDate: response.returnDate,
            members: response.members as TravelMember[],
            infoCollected: true,
        };
    }

    const question =
        response.followUpQuestion?.trim() ||
        `I have: ${[
            response.origin && `origin: ${response.origin}`,
            response.destination && `destination: ${response.destination}`,
            response.startDate && `start: ${response.startDate}`,
            response.returnDate && `return: ${response.returnDate}`,
            response.members?.length && `${response.members.length} traveler(s)`,
        ]
            .filter(Boolean)
            .join(", ")}. Could you confirm the missing details (${
            [
                !response.startDate && "start date",
                !response.returnDate && "return date or trip duration",
                hasUnknownAges && "children's ages",
            ]
                .filter(Boolean)
                .join(", ")
        })?`;

    return {
        messages: [new AIMessage(question)],
        infoCollected: false,
    };
}
