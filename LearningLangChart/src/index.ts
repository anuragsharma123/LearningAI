import readline from "node:readline";
import { HumanMessage } from "@langchain/core/messages";
import { travelAgent } from "./travelAgent.js";
import { mongoClient } from "./db.js";

const THREAD_ID = process.argv[2] ?? `travel-${Date.now()}`;
const config = { configurable: { thread_id: THREAD_ID } };

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(prompt: string): Promise<string> {
    return new Promise((resolve) => rl.question(prompt, resolve));
}

function startSpinner(message: string): NodeJS.Timeout {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    process.stdout.write("\n");
    return setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  ${message}`);
    }, 100);
}

function stopSpinner(spinner: NodeJS.Timeout): void {
    clearInterval(spinner);
    process.stdout.write("\r" + " ".repeat(60) + "\r");
}

async function main() {
    console.log("=== Travel Planning Agent ===");
    console.log(`Session ID: ${THREAD_ID}`);
    console.log('Type your trip details or "exit" to quit.\n');

    let planDelivered = false;

    while (true) {
        const input = await ask("You: ");
        if (input.trim().toLowerCase() === "exit") break;
        if (input.trim() === "") continue;

        const spinner = startSpinner(
            planDelivered ? "Thinking about your question..." : "Thinking..."
        );

        let state;
        try {
            state = await travelAgent.invoke(
                { messages: [new HumanMessage(input)] },
                config
            );
        } finally {
            stopSpinner(spinner);
        }

        // Print the final plan the first time it's ready
        if (state.finalPlan && !planDelivered) {
            planDelivered = true;
            console.log("\n--- Full Travel Plan ---\n");
            console.log(state.finalPlan);
            console.log('\n(Plan saved. Ask follow-up questions or type "exit" to quit)\n');
            continue;
        }

        // Print the most recent agent reply (follow-up answer or info-collection question)
        const lastMessage = state.messages[state.messages.length - 1];
        const reply =
            typeof lastMessage?.content === "string"
                ? lastMessage.content
                : JSON.stringify(lastMessage?.content);

        console.log(`\nAgent: ${reply}\n`);
    }

    rl.close();
    await mongoClient.close();
    console.log("\nSession ended.");
    console.log(`To resume this session later, run:\n  npm start ${THREAD_ID}`);
}

main().catch((error) => {
    console.error("An error occurred:", error);
    rl.close();
    mongoClient.close().catch(() => {});
});
