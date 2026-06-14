import readline from "node:readline";
import { HumanMessage } from "@langchain/core/messages";
import { travelAgent } from "./travelAgent.js";

const THREAD_ID = `travel-${Date.now()}`;
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
    process.stdout.write("\r" + " ".repeat(60) + "\r"); // clear spinner line
}

async function main() {
    console.log("=== Travel Planning Agent ===");
    console.log('Type your trip details or "exit" to quit.\n');

    while (true) {
        const input = await ask("You: ");
        if (input.trim().toLowerCase() === "exit") break;

        const spinner = startSpinner("Thinking...");

        let state;
        try {
            state = await travelAgent.invoke(
                { messages: [new HumanMessage(input)] },
                config
            );
        } finally {
            stopSpinner(spinner);
        }

        // If info collection is complete, searches are running — show a longer status
        if (state.finalPlan) {
            console.log("\n--- Full Travel Plan ---\n");
            console.log(state.finalPlan);
            break;
        }

        const lastMessage = state.messages[state.messages.length - 1];
        const reply =
            typeof lastMessage?.content === "string"
                ? lastMessage.content
                : JSON.stringify(lastMessage?.content);

        console.log(`\nAgent: ${reply}\n`);
    }

    rl.close();
}

main().catch((error) => {
    console.error("An error occurred:", error);
    rl.close();
});
