import agent, { budgetStore } from "./agent.js";
import { todayHelper } from "./types.js";


const result1 = await agent.invoke(
  { messages: [{ role: "user", content: "Say hello in one sentence." }] },
  { context: { customerId: "cust-1" } }
);

//Testing daily budget exceeded scenario (took AI help for review and testing)
console.log(result1.messages.at(-1)?.content);
budgetStore.addSpend("cust-1", todayHelper(), 9);

const result2 = await agent.invoke(
  { messages: [{ role: "user", content: "Are you still there?" }] },
  { context: { customerId: "cust-1" } }
);
console.log(result2.messages.at(-1)?.content); // should be the "Daily budget exceeded" message

const result3 = await agent.invoke(
  { messages: [{ role: "user", content: "Say hello in one sentence." }] },
  { context: { customerId: "cust-2" } }
);
console.log(result3.messages.at(-1)?.content);