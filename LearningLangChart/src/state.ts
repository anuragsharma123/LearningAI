import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export type TravelMember = { name: string; age: number | null };

export const TravelState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
    }),
    origin: Annotation<string>(),
    destination: Annotation<string>(),
    startDate: Annotation<string>(),
    returnDate: Annotation<string>(),
    members: Annotation<TravelMember[]>({
        reducer: (_, b) => b,
        default: () => [],
    }),
    // Concat reducers so parallel Send() workers can each write partial results
    flightResults: Annotation<string>({
        reducer: (a, b) => (a && b ? `${a}\n${b}` : a || b),
        default: () => "",
    }),
    hotelResults: Annotation<string>({
        reducer: (a, b) => (a && b ? `${a}\n${b}` : a || b),
        default: () => "",
    }),
    weatherSummary: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),
    entertainmentOptions: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),
    finalPlan: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
    }),
    infoCollected: Annotation<boolean>({
        reducer: (_, b) => b,
        default: () => false,
    }),
});
