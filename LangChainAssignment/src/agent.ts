import { createAgent } from "langchain";
import {ChatAnthropic} from "@langchain/anthropic"
import {createBudgetMiddleware} from "./middleware/budgetMiddleware.js";
import { InMemoryBudgetStore } from "./middleware/budgetStore.js";

export const budgetStore = new InMemoryBudgetStore();

const agent = createAgent({
    model: new ChatAnthropic({ model: "claude-haiku-4-5-20251001" }),
    middleware: [createBudgetMiddleware(budgetStore)],
});

export default agent;