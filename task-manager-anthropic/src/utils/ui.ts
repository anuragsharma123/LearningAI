/**
 * startSpinner — prints an animated spinner to stdout while the agent is thinking.
 *
 * Returns the interval timer so the caller can pass it to stopSpinner() when done.
 * `\r` (carriage return without newline) overwrites the same line on each tick,
 * creating the spinning animation without scrolling the terminal.
 */
export function startSpinner(message: string): NodeJS.Timeout {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    process.stdout.write("\n");
    return setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  ${message}`);
    }, 100);
}

/**
 * stopSpinner — clears the spinner line and restores the cursor to the start of the line.
 * Writing spaces equal to the spinner line length erases the animation before returning
 * control to the caller to print the agent's reply.
 */
export function stopSpinner(spinner: NodeJS.Timeout): void {
    clearInterval(spinner);
    process.stdout.write("\r" + " ".repeat(60) + "\r");
}
