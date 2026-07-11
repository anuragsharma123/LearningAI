/**
 * Entry point — two lines, same as LearningLangChart.
 * All startup logic lives in cli.ts so this file stays trivially small.
 * `main().catch(console.error)` ensures unhandled rejections print to stderr
 * and exit the process rather than hanging silently.
 */
import { main } from "./cli.js";
main().catch(console.error);
