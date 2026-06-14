import { TravelState } from "../state.js";
import searchFlights from "../tools/searchFlights.js";

export async function searchFlightsNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    const memberCount = state.members?.length ?? 1;

    const result = await searchFlights.invoke({
        origin: state.origin,
        destination: state.destination,
        startDate: state.startDate,
        returnDate: state.returnDate,
        memberCount,
    });

    return { flightResults: result };
}
