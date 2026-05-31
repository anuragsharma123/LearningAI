# AI Task Manager

A multi-agent TypeScript task manager built with the **Model Context Protocol (MCP)** and **Anthropic's Claude API**. Demonstrates Level 5 agentic architecture: autonomous orchestration, agent-to-agent communication, and persistent vector memory.

## Architecture

```
User
  │
  ▼
Orchestrator (Claude reasoning agent)
  │  calls subagents as tools
  ├──▶ Gmail Subagent
  │      └── reads Gmail (today + 2 months)
  │      └── extracts TaskSuggestions via forced tool call
  │      └── runs suggestions through Filter MCP Server
  │
  └──▶ Task Manager Subagent
         └── semantic dedup via LanceDB memory
         └── creates tasks via Task Server MCP
         └── stores results back into memory

┌─────────────────────────────────────┐
│  MCP Servers (stdio child processes) │
│  task-server/   — task CRUD + JSON  │
│  filter-server/ — email filter rules │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  Persistent Memory (LanceDB)         │
│  email_patterns — recurring bills   │
│  task_history   — semantic dedup    │
│  run_history    — cross-run context │
└─────────────────────────────────────┘
```

## Setup

```bash
npm install
```

Create a `.env` file:
```
ANTHROPIC_API_KEY=sk-ant-...
```

For Gmail access, follow [gmail-agent/credentials/README.md](gmail-agent/credentials/README.md).

## Usage

### Run the full pipeline (orchestrator)
```bash
npm start                    # starts scheduler — runs at 09:00 on 1st & 15th
npm start -- --run-now       # run once immediately
```

### Interactive task manager chat
```bash
npm run client
```

### Interactive filter rules manager
```bash
npm run filters
```

### Gmail agent standalone
```bash
npm run gmail-agent
```

### MCP task server standalone
```bash
npm run server
```

## MCP Tools

**task-server** exposes:
- `create_task` — create a new task
- `list_tasks` — list all tasks (rendered as a Unicode table)
- `get_task` — get a task by ID
- `update_task` — update title, description, or status
- `complete_task` — mark a task done
- `delete_task` — delete a task

**filter-server** exposes:
- `add_filter_rule` — add an email filter rule (alert_only or drop)
- `list_filter_rules` — list all rules
- `delete_filter_rule` — remove a rule
- `apply_filters` — run suggestions through all rules

## Project Structure

```
.
├── orchestrator.ts              # Top-level orchestrator agent + scheduler
├── task-manager.ts              # Interactive chat client (MCP + Claude)
├── filter-cli.ts                # Interactive filter rules client
├── task-server/
│   ├── index.ts                 # MCP server — task tools + JSON persistence
│   └── types.d.ts               # Shared types (Task, TaskStatus, TaskSuggestion)
├── filter-server/
│   ├── index.ts                 # MCP server — filter rules
│   └── types.d.ts               # Filter types (FilterRule, FilterResult)
├── gmail-agent/
│   ├── index.ts                 # Gmail subagent (analyzeGmail export + standalone)
│   ├── gmail.ts                 # Gmail OAuth2 + email fetch helpers
│   └── credentials/             # OAuth credentials (git-ignored)
├── memory/
│   ├── index.ts                 # MemoryManager — LanceDB vector memory
│   ├── embeddings.ts            # Local all-MiniLM-L6-v2 embeddings (384-dim)
│   └── schemas.ts               # LanceDB table schemas
├── system-prompt.md             # Claude persona for interactive client
├── gmail-agent-prompt.md        # Claude instructions for Gmail agent
├── orchestrator-prompt.md       # Claude instructions for orchestrator
├── filter-cli-prompt.md         # Claude persona for filter CLI
├── tsconfig.json
└── package.json
```

## Key Concepts Demonstrated

| Concept | Where |
|---|---|
| MCP server + tools | `task-server/`, `filter-server/` |
| MCP client (Claude + tools) | `task-manager.ts`, `filter-cli.ts` |
| Forced structured output | `gmail-agent/index.ts` — `tool_choice: { type: "tool" }` |
| Agent-to-agent (A2A) | `orchestrator.ts` — subagents called as Claude tools |
| Persistent vector memory | `memory/` — LanceDB + local embeddings |
| Semantic deduplication | `memory/index.ts` — cosine similarity at threshold 0.88 |
| Email filtering rules | `filter-server/` — alert_only or drop, with reason |
| Scheduled automation | `orchestrator.ts` — node-cron `"0 9 1,15 * *"` |
