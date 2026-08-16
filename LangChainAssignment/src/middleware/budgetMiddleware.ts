import { createMiddleware, AIMessage } from "langchain";
import * as z from "zod";
import type { BudgetStore } from "./budgetStore.js";
import { todayHelper } from "../types.js";


export function createBudgetMiddleware(store: BudgetStore) {
  return createMiddleware({
    name: "BudgetMiddleware",
    contextSchema: z.object({ customerId: z.string() }),
    beforeModel: {
        canJumpTo: ["end"],
        hook: (state, runtime) => {
            const { customerId } = runtime.context;
            if (store.getSpend(customerId, todayHelper()) >= store.getBudget(customerId)) {
            return {
                messages: [new AIMessage(`Daily budget exceeded for ${customerId}, stopping.`)],
                jumpTo: "end",
            };
            }
            return undefined;
        },    
    },// calculate actual use after every model call and add to spend
    wrapModelCall: async (request, handler) => {
        const { customerId } = request.runtime.context;
        const response = await handler(request);      
        const usage = response.usage_metadata; 
        if (usage) {
            store.addSpend(customerId, todayHelper(), costUsd(usage));
        }
        return response;
    },
   
  });
}

//Haiku takes 1$/1M input tokens and 5$/1M output tokens. This function calculates the cost in USD based on the number of input and output tokens used.    
function costUsd(usage: { input_tokens: number; output_tokens: number }): number {
  return (usage.input_tokens / 1_000_000) * 1 + (usage.output_tokens / 1_000_000) * 5;
}