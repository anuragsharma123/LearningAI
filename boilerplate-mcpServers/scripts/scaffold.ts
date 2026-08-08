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
    for (const file of ["tsconfig.json", ".eslintrc.json", ".gitignore"]) {
      cpSync(join(boilerplateRoot, file), join(destPath, file));
    }

    const projectName = basename(targetProjectPath);
    const pkgName = `${projectName}-${subfolder}`;
    const pkg = JSON.parse(readFileSync(join(boilerplateRoot, "package.json"), "utf-8"));
    pkg.name = pkgName;
    pkg.version = "0.1.0";
    delete pkg.scripts.scaffold;
    writeFileSync(join(destPath, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

    const indexTsPath = join(destPath, "src", "index.ts");
    const indexTs = readFileSync(indexTsPath, "utf-8").replace(
      /name: "mcp-server-boilerplate"/,
      `name: "${pkgName}"`
    );
    writeFileSync(indexTsPath, indexTs);

    const readme = `# ${pkgName}

MCP tools for ${projectName}, scaffolded from boilerplate-mcpServers.

## Setup

\`\`\`bash
cd ${subfolder}
npm install
npm run build
\`\`\`

## Adding a new tool

See \`src/tools/index.ts\` — add a file under \`src/tools/\` using \`defineTool\`
from \`src/tools/types.ts\`, then register it in the \`tools\` array.

## Connecting to Claude Code

Run from inside \`${projectName}/\`:

\`\`\`bash
claude mcp add ${pkgName} -- node ${subfolder}/dist/index.js
\`\`\`
`;
    writeFileSync(join(destPath, "README.md"), readme);

    console.log(`\nInstalling dependencies in ${destPath}...`);
    execFileSync("npm", ["install"], { cwd: destPath, stdio: "inherit" });

    console.log(`\nDone. Next steps:
  cd ${targetProjectPath}
  npm run build --prefix ${subfolder}
  claude mcp add ${pkgName} -- node ${subfolder}/dist/index.js
`);
  } finally {
    rl.close();
  }
}

main().catch((error: Error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
