import { TravelState } from "../state.js";
import searchHotels from "../tools/searchHotels.js";

export async function searchHotelsNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    const memberCount = state.members?.length ?? 1;

    const result = await searchHotels.invoke({
        destination: state.destination,
        checkIn: state.startDate,
        checkOut: state.returnDate,
        memberCount,
    });

    return { hotelResults: result };
}
