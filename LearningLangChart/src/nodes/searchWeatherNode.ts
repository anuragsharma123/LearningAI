import { TravelState } from "../state.js";
import getWeather from "../tools/weather.js";

export async function searchWeatherNode(
    state: typeof TravelState.State
): Promise<Partial<typeof TravelState.State>> {
    const result = await getWeather.invoke({
        city: state.destination,
        date: state.startDate,
    });

    return { weatherSummary: result };
}
