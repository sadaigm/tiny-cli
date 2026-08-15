# 📗 tiny-cli User Guide

This guide provides comprehensive, hands-on instructions for using `tiny-cli` — a lightweight agentic AI coding assistant that works with any OpenAI-compatible model endpoint.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Interactive REPL](#interactive-repl)
- [Headless / Single-Query Mode](#headless--single-query-mode)
- [Execution Modes](#execution-modes)
- [Slash Commands](#slash-commands)
- [File Mentions (`@`)](#file-mentions-)
- [Permission Modes](#permission-modes)
- [Tools](#tools)
- [Sessions](#sessions)
- [Configuration](#configuration)
- [MCP Integration](#mcp-integration)
- [Context & Memory Compaction](#context--memory-compaction)
- [Docker](#docker)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** ≥ 9 (for building from source)
- A running **OpenAI-compatible** model endpoint. The default target is a local [Ollama](https://ollama.com/) server (`http://localhost:11434/v1`), but any compatible API (e.g., LM Studio, vLLM, OpenAI, OpenRouter) works.

> **Tip:** Pull a model before starting, e.g. `ollama pull llama3.2`.

---

## Quick Start

```bash
# Clone and build
git clone https://github.com/sadaigm/tiny-cli.git
cd tiny-cli
pnpm install
pnpm build

# (Optional) Link globally so you can run `tiny-cli` from anywhere
cd packages/cli
pnpm link --global
```

Start the interactive REPL:

```bash
tiny-cli
```

Or run a single headless task:

```bash
tiny-cli "add a README section about environment variables"
```

---

## Interactive REPL

The REPL is the primary way to use `tiny-cli`. It launches a full-screen terminal UI powered by [Ink](https://github.com/vadimdemedes/ink).

```bash
tiny-cli                    # Start in default (agent) mode
tiny-cli --mode plan        # Start in plan (read-only) mode
tiny-cli --mode chat        # Start in chat (no tools) mode
```

Inside the REPL you can:

- Type a prompt and press **Enter** to send it to the agent.
- Type **`/`** to open the slash-command menu.
- Type **`@`** to open the file-mention picker.
- Use **`/exit`** to save your session and quit.

---

## Headless / Single-Query Mode

Pass a query directly to run a single task and exit. This is ideal for scripting and CI/CD pipelines.

```bash
tiny-cli "build a web app"                     # Run in agent mode
tiny-cli -q "draft an architecture" -m plan    # Run in plan mode
tiny-cli --resume <session-id> "continue"      # Resume a previous session
```

| Flag | Description |
|:---|:---|
| `-r, --resume <id>` | Resume a specific session by ID |
| `-q, --query <text>` | Explicitly pass a query to execute and exit |
| `-m, --mode <type>` | Execution mode: `agent` (default), `plan`, or `chat` |

> **Note:** Headless execution always uses `auto` permission mode — interactive approval prompts are not supported outside the REPL. If your config is set to `notify`, it will be automatically overridden to `auto` with a warning.

---

## Execution Modes

`tiny-cli` supports three execution modes, each suited to different tasks:

| Mode | Description | Can write code? |
|:---|:---|:---|
| **Agent** (`/agent`) | Full autonomy — research, plan, edit, execute, and verify. Best for building features and fixing bugs. | ✅ Yes |
| **Plan** (`/plan`) | Read-only research sandbox. The agent explores the codebase and produces an implementation plan without modifying files. | ❌ No |
| **Chat** (`/chat`) | Conversational Q&A. No tool calls — pure discussion. | ❌ No |

A plan produced in **Plan Mode** can be executed in **Agent Mode** using the `/continue` command.

---

## Slash Commands

Type `/` in the REPL to bring up the command menu. Use **arrow keys** to navigate and **Enter** to select.

| Command | Description |
|:---|:---|
| `/agent` | Switch to autonomous agent mode |
| `/chat` | Switch to conversational chat mode |
| `/plan` | Switch to planning mode |
| `/model` | Select a different LLM model (fetched from your endpoint) |
| `/tools` | List available tools |
| `/mcp` | Manage MCP server connections |
| `/session` | List, load, or create conversation sessions |
| `/mode` | Switch permission mode (`notify`, `auto-edit`, `auto`) |
| `/continue` | Continue executing the active plan |
| `/queue` | Show messages queued while the agent works (`/queue clear` drops them) |
| `/clear` | Clear conversation history |
| `/help` | List all commands and keyboard shortcuts |
| `/mouse` | Toggle mouse-wheel scrolling of the conversation pane |
| `/exit` | Save session and quit |

Commands that have sub-options (e.g., `/model`, `/session`, `/tools`) transition into a second selection submenu.

### Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `Enter` | Submit the prompt |
| `Shift+Enter` | Insert a newline (multi-line prompt) |
| `↑` / `↓` | Recall previous inputs (shell-style history) — when no picker is open |
| `Ctrl+P` | Toggle browse mode: `↑/↓` scroll the log, `Tab` expands an entry, `Esc` returns to typing |
| `Esc` | Abort the running agent turn |
| `Ctrl+C` ×2 | Exit (press twice within 2 seconds; the first press shows a hint) |
| `Ctrl+D` | Exit immediately |

While the agent is working, anything you type and submit is **queued** and processed in order after the current turn — the input never freezes. Use `/queue` to inspect the queue.

---

## File Mentions (`@`)

Type **`@`** anywhere in your prompt to trigger the file-mention picker. This lets you inject file contents directly into the agent's context.

**How it works:**
1. Typing `@` opens a fuzzy-search overlay listing files in your workspace.
2. Start typing to filter — matches update instantly.
3. Select a file (or multiple) with **Enter**.
4. The full contents of each selected file are read and included as context when you send the prompt.

This is essential when you want the agent to "see" a specific file without manually pasting its contents.

---

## Permission Modes

Permission modes control how much autonomy the agent has when executing tools. Switch modes at any time with `/mode`.

| Mode | Behavior |
|:---|:---|
| **`notify`** *(default)* | Prompts you for approval before **every** tool call. Safest option. |
| **`auto-edit`** | Automatically approves file operations (`read`, `write`, `search_replace`, etc.). Prompts for approval before `bash` commands. |
| **`auto`** | No prompts. All tool calls execute automatically. Best for trusted tasks and headless mode. |

> **Security Note:** Use `auto` mode only in environments where you trust the agent's actions. In `notify` mode, you can choose `[y]es`, `[n]o`, or `[a]bort` for each tool call.

---

## Tools

The agent uses a set of built-in tools to research and modify your codebase. Use `/tools` in the REPL to view the full list at runtime.

### Core Tools

| Tool | Description | Modifies files? |
|:---|:---|:---|
| **`bash`** | Execute a shell command in your environment | System-level |
| **`read`** | Read a file (first 250 lines, last 100 lines, or a specific range) | No |
| **`write`** | Create or overwrite a file with specific content | ✅ Yes |
| **`search_replace`** | Surgically replace an exact block of text in a file | ✅ Yes |
| **`insert_lines`** | Insert text at a specific line number (before/after) | ✅ Yes |
| **`list`** | List contents of a directory | No |
| **`grep`** | Search for patterns in file contents (recursive) | No |
| **`glob`** | Find files by pattern (e.g., `src/**/*.ts`) | No |

### Planning Tools

| Tool | Description |
|:---|:---|
| **`plan_write`** | Write a planning document (`.md`/`.txt`) to the session's plan folder |
| **`manage_tasks`** | Add, list, or mark-done tasks in the current plan (`current_task.md`) |
| **`mark_task_complete`** | Signal that the current task is fully implemented and verified |

Additionally, any tools provided by connected **MCP servers** are automatically discovered and registered.

---

## Sessions

Every conversation is saved as a session. Sessions store the full message history and metadata (creation time, last-updated time, permission mode).

**Session storage location:**
- Project-local: `.tiny-cli/sessions/<session-id>.json`

**Managing sessions:**

```bash
# List, load, or create a session via the REPL
/session

# Resume a specific session from the command line
tiny-cli --resume <session-id>

# After headless execution, the CLI prints how to resume:
#   tiny-cli --resume <session-id>
```

Sessions are sorted by last-updated time in the `/session` picker. When you `/exit` the REPL, your current session is saved automatically.

---

## Configuration

`tiny-cli` reads configuration from the following locations (in priority order):

1. **Project-local:** `.tiny-cli/agents.json` (in your current working directory)
2. **Home directory:** `~/.tiny-cli/agents.json`

If neither exists, `tiny-cli` auto-creates a default config at `~/.tiny-cli/agents.json` on first run.

> **Note:** The config file is an **array of agent profiles**. `tiny-cli` uses the profile named `"default"` (or the first one if `"default"` is absent).

### Example Configuration

```json
[
  {
    "name": "default",
    "model": "llama3.2:latest",
    "description": "Default local assistant (Ollama)",
    "temperature": 0.7,
    "systemPrompt": "...",
    "permissionMode": "notify",
    "logLevel": "LOG",
    "maxIterations": 50,
    "environment": {
      "hostUrl": "http://localhost:11434",
      "appBasePath": "/v1",
      "apiKey": "...",
      "insecure": true
    },
    "mcpServers": [
      {
        "name": "my-remote-tools",
        "type": "http",
        "url": "http://localhost:3001/mcp"
      },
      {
        "name": "local-tools",
        "type": "stdio",
        "command": "npx",
        "args": ["my-mcp-server"]
      }
    ]
  }
]
```

### Configuration Reference

| Field | Description | Default |
|:---|:---|:---|
| `name` | Profile name (`"default"` is used automatically) | `"default"` |
| `model` | Model identifier (e.g., `llama3.2:latest`) | `llama3.2:latest` |
| `description` | Human-readable description | — |
| `temperature` | Sampling temperature (0.0–1.0) | `0.7` |
| `systemPrompt` | Override the built-in system prompt | Built-in default |
| `permissionMode` | `notify`, `auto-edit`, or `auto` | `notify` |
| `logLevel` | `TRACE`, `DEBUG`, `LOG`, or `ERROR` | `LOG` |
| `maxIterations` | Max agent loop iterations per query | Unlimited |
| `environment.hostUrl` | Model API host URL | `http://localhost:11434` |
| `environment.appBasePath` | API path prefix | `/v1` |
| `environment.apiKey` | API key for authenticated endpoints | — |
| `environment.insecure` | Skip TLS certificate verification | `false` |
| `mcpServers` | Array of MCP server configurations | `[]` |

> **Endpoint resolution:** The full endpoint is built as `{environment.hostUrl}{environment.appBasePath}`. For example, `http://localhost:11434` + `/v1` = `http://localhost:11434/v1`.

### Log Levels

| Level | What it shows |
|:---|:---|
| `TRACE` | Everything — request/response tracing, internal state |
| `DEBUG` | Debug + normal output + errors |
| `LOG` | Normal output and errors *(default)* |
| `ERROR` | Errors only |

---

## MCP Integration

`tiny-cli` is a first-class **MCP (Model Context Protocol) Host**. You can connect external tool servers and their tools are automatically registered and available to the agent.

**Supported transports:**

| Transport | Use case | Config fields |
|:---|:---|:---|
| **`stdio`** | Local processes | `command`, `args`, `env` |
| **`http`** | Remote HTTP/SSE servers | `url` |

**Managing MCP servers at runtime:**

Use the `/mcp` command in the REPL to:
- List connected servers and their status
- Connect to a server
- Disconnect from a server

> MCP servers connect in the **background** — the REPL is never blocked during startup. Connection status is logged after each prompt.

---

## Context & Memory Compaction

Long conversations can exceed the model's context window. `tiny-cli` handles this automatically with **Memory Compaction**:

1. **Trigger:** When a session exceeds **35,000 tokens**.
2. **Analysis:** The agent identifies older conversation segments no longer relevant to the current task.
3. **Summarization:** Stale segments are compressed into high-density "Memory Notes."
4. **Preservation:** The most recent **10,000 tokens** are kept in raw form. System prompts and critical project context are never summarized.

This allows you to run long, multi-step sessions without hitting context limits or losing important context.

---

## Docker

You can run `tiny-cli` in a containerized environment.

```bash
# Build the image
docker build -t tiny-cli .

# Run interactively (must use -it for TTY)
docker run -it tiny-cli
```

> The `-it` flag is **required** — without it, the interactive REPL cannot function.

---

## Troubleshooting

### The REPL doesn't start / appears frozen
- Ensure your terminal supports interactive TTY mode.
- Try running with `node ./packages/cli/dist/index.js` directly.
- Check the log level: set `"logLevel": "DEBUG"` in your config for diagnostic output.

### Model request errors / timeouts
- Verify your model endpoint is running and reachable (`curl http://localhost:11434/v1/models`).
- Check `environment.hostUrl` and `environment.appBasePath` in your config.
- If using self-signed certificates, set `"insecure": true`.
- The default request timeout is **120 seconds**. Stalled requests are automatically terminated.

### `search_replace` fails with "Search block not found"
- The search block must match **exactly**, including all whitespace and indentation.
- Ensure the block appears **exactly once** in the file (multiple matches are rejected).
- Line endings are normalized automatically (CRLF → LF).

### File mentions (`@`) don't show files
- Ensure you're in the correct working directory (`tiny-cli` indexes from `process.cwd()`).
- Check that the files exist and are readable.

### Headless mode says it's overriding to `auto`
- This is expected. Headless mode cannot show interactive approval prompts, so `notify` is always overridden to `auto`. Use the REPL if you need per-action approval.

---

## FAQ

**Q: Can I use `tiny-cli` with cloud models like GPT-4 or Claude?**
Yes. Any OpenAI-compatible endpoint works. Point `environment.hostUrl` to the provider's API base URL and set `environment.apiKey`.

**Q: How do I switch models without editing the config file?**
Use the `/model` command in the REPL. It fetches the available models from your endpoint and lets you select one interactively.

**Q: What's the difference between Plan Mode and Agent Mode?**
Plan Mode is read-only — the agent researches and produces a strategy but cannot modify files. Agent Mode has full read/write/execute access. Use `/continue` to transition a plan into Agent Mode.

**Q: Where are my sessions stored?**
In `.tiny-cli/sessions/<session-id>.json` relative to your working directory. Use `/session` in the REPL to browse them.

**Q: Does `tiny-cli` work offline?**
Yes, if your model endpoint runs locally (e.g., Ollama). No external internet connection is required.

**Q: How do I add custom tools?**
Connect an MCP server that exposes the tools you need. See the [MCP Integration](#mcp-integration) section. Custom tools are automatically discovered and registered.

---

*For architectural details and contribution guidelines, see the [README.md](README.md).*
