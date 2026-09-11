import { z } from "zod";

// All configuration comes from the environment — nothing is ever hard-coded.
// Fails fast at startup with a clear message rather than throwing deep
// inside a request handler later. Extend EnvSchema as your server grows
// (e.g. an API token) — every new field should be validated here, not read
// from process.env ad hoc elsewhere.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
});

function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
