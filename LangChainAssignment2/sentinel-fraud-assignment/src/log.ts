/** Progress logging to stderr, so stdout stays clean JSON for scripts/pipes. */
export function log(scope: string, message: string): void {
  process.stderr.write(`[${scope}] ${message}\n`);
}
