export function startSpinner(message: string): NodeJS.Timeout {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    process.stdout.write("\n");
    return setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  ${message}`);
    }, 100);
}

export function stopSpinner(spinner: NodeJS.Timeout): void {
    clearInterval(spinner);
    process.stdout.write("\r" + " ".repeat(60) + "\r");
}
