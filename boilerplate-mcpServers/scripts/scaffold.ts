#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";

// Drops this boilerplate's MCP tool pattern into an existing project as a
// subfolder, on a fresh git branch. Run with `npm run scaffold`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const boilerplateRoot = resolve(__dirname, "..");

// Supports --target/--subfolder/--branch flags so the script can also run
// non-interactively; falls back to prompting for whatever isn't passed.
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return flags;
}

async function prompt(
  rl: Interface,
  question: string,
  options: { defaultValue?: string } = {}
): Promise<string> {
  const { defaultValue } = options;
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  for (;;) {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    if (answer) return answer;
    if (defaultValue !== undefined) return defaultValue;
    console.log("This field is required.");
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const targetInput =
      flags.target ??
      (await prompt(rl, "Target project path (relative to current directory)"));
    const targetProjectPath = resolve(process.cwd(), targetInput);

    if (!existsSync(targetProjectPath)) {
      throw new Error(`Target project path does not exist: ${targetProjectPath}`);
    }

    const subfolder =
      flags.subfolder ?? (await prompt(rl, "Subfolder name", { defaultValue: "mcp-tools" }));
    const destPath = join(targetProjectPath, subfolder);

    if (existsSync(destPath)) {
      throw new Error(
        `${destPath} already exists. Choose a different subfolder name or remove it first.`
      );
    }

    const branchName = flags.branch ?? (await prompt(rl, "New git branch name"));

    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: boilerplateRoot,
    })
      .toString()
      .trim();

    console.log(`\nCreating branch '${branchName}' off current HEAD in ${repoRoot}...`);
    execFileSync("git", ["checkout", "-b", branchName], { cwd: repoRoot, stdio: "inherit" });

    console.log(`Copying boilerplate into ${destPath}...`);
    mkdirSync(destPath, { recursive: true });
    cpSync(join(boilerplateRoot, "src"), join(destPath, "src"), { recursive: true });
    for (const file of ["tsconfig.json", ".eslintrc.json", ".gitignore", ".env.example"]) {
      cpSync(join(boilerplateRoot, file), join(destPath, file));
    }

    const projectName = basename(targetProjectPath);
    const pkgName = `${projectName}-${subfolder}`;
    const pkg = JSON.parse(readFileSync(join(boilerplateRoot, "package.json"), "utf-8"));
    pkg.name = pkgName;
    pkg.version = "0.1.0";
    delete pkg.scripts.scaffold;
    // The boilerplate's own scripts/ (this scaffolder) isn't copied into the
    // destination project, so drop the parts of typecheck/lint that point at it.
    pkg.scripts.typecheck = "tsc --noEmit";
    pkg.scripts.lint = "eslint src --ext .ts";
    writeFileSync(join(destPath, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

    // src/server.ts is the one place the server's identity lives — every
    // entrypoint (HTTP, stdio) and their log lines inherit SERVER_NAME from
    // it, so patching it here is enough.
    const serverTsPath = join(destPath, "src", "server.ts");
    const serverTs = readFileSync(serverTsPath, "utf-8").replace(
      /SERVER_NAME = "mcp-server-boilerplate"/,
      `SERVER_NAME = "${pkgName}"`
    );
    writeFileSync(serverTsPath, serverTs);

    const readme = `# ${pkgName}

MCP tools for ${projectName}, scaffolded from boilerplate-mcpServers.
Runs over Streamable HTTP by default — one URL to register, no subprocess.

## Setup

\`\`\`bash
cd ${subfolder}
cp .env.example .env
npm install
npm run build
\`\`\`

## Run

\`\`\`bash
npm run dev      # tsx, no build step, for local iteration
npm start          # run the compiled dist/index.js
\`\`\`

Listens on \`http://localhost:$PORT/mcp\` (default port 3333;
\`GET /healthz\` for a no-auth status check).

## Adding a new tool

See \`src/tools/index.ts\` — add a file under \`src/tools/\` using \`defineTool\`
from \`src/tools/types.ts\` (set \`annotations.readOnlyHint\`/\`destructiveHint\`
honestly — a registry may use them to decide what needs approval), then
register it in the \`tools\` array.

## Registering this server

Paste \`http://localhost:$PORT/mcp\` wherever an MCP server address is
expected — an MCP registry, the MCP Inspector, or Claude Code:

\`\`\`bash
claude mcp add --transport http ${pkgName} http://localhost:3333/mcp
\`\`\`

Prefer a subprocess Claude Code launches itself instead of a URL? Use the
stdio entrypoint:

\`\`\`bash
npm run build
claude mcp add ${pkgName} -- node dist/stdio.js
\`\`\`
`;
    writeFileSync(join(destPath, "README.md"), readme);

    console.log(`\nInstalling dependencies in ${destPath}...`);
    execFileSync("npm", ["install"], { cwd: destPath, stdio: "inherit" });

    console.log(`\nDone. Next steps:
  cd ${targetProjectPath}/${subfolder}
  cp .env.example .env
  npm run build
  npm start
  # in another terminal:
  claude mcp add --transport http ${pkgName} http://localhost:3333/mcp
`);
  } finally {
    rl.close();
  }
}

main().catch((error: Error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
