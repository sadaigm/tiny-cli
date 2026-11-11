# Product Router (`product.md`)

Tree and navigation map for the core product logic, agent engine, execution model, tools, and CLI UI. Read this file to locate functional product features.

## Architecture & Code Tree

```text
packages/
├── cli/                                    # Terminal User Interface (TUI) and application entrypoint
│   └── src/
│       ├── index.ts                        # CLI bootstrap, argument parsing, interactive session launch
│       ├── config.ts                       # CLI configuration, environment variable loaders, options
│       ├── file-mention.ts                 # Parsing and autocomplete for '@file' mentions
│       ├── types.d.ts                      # Ambient TypeScript type definitions for CLI
│       ├── commands/
│       │   └── handlers.ts                 # Slash commands handler implementations (/help, /clear, etc.)
│       └── tui/                            # React-based OpenTUI terminal interface
│           ├── app.tsx                     # Main interactive terminal UI container and layout
│           ├── render.tsx                  # Ink / OpenTUI screen renderer initialization
│           ├── state.ts                    # TUI application reactive state store
│           ├── streamStore.ts              # Agent token streaming and output chunk buffer
│           ├── keybindings.ts              # Keyboard navigation, shortcuts, and key map bindings
│           ├── theme.ts                    # UI color palettes and styling configurations
│           ├── compat.tsx                  # Terminal compatibility and rendering fallbacks
│           ├── components/                 # UI components (chat, inputs, spinners, tool displays)
│           ├── hooks/                      # Custom React hooks for terminal events and input handling
│           └── utils/                      # Terminal formatting, text truncation, and color utilities
├── core/                                   # Agent runtime, LLM client, orchestration, and tool system
│   └── src/
│       ├── index.ts                        # Main export barrel for @tiny-cli/core
│       ├── agent.ts                        # Core Agent loop: prompt build, LLM call, tool dispatch
│       ├── session.ts                      # Chat history, session context, and persistence management
│       ├── types.ts                        # Core interfaces (AgentConfig, Message, ToolDefinition, etc.)
│       ├── logger.ts                       # Structured logging utility with file and console transports
│       ├── instructions.ts                 # System instructions and prompt loader
│       ├── concurrency.ts                  # Concurrency limiter and parallel task runner
│       ├── compact_utils.ts                # Message compaction, truncation, and context window pruning
│       ├── agent/
│       │   ├── toolExecution.ts            # Dispatches, executes, and sanitizes tool calls
│       │   ├── compaction.ts               # Automated context compaction during long sessions
│       │   └── textToolCalls.ts            # Fallback parser for tool calls emitted inside raw text
│       ├── model/
│       │   ├── client.ts                   # LLM client supporting Gemini, OpenAI, Claude, and local models
│       │   └── thinking.ts                 # Extraction and handling for model thinking / reasoning tokens
│       ├── prompts/
│       │   ├── default.ts                  # Standard system prompts and base identity definitions
│       │   ├── agent.ts                    # Dynamic agent execution prompt builders
│       │   ├── planning.ts                 # Task planning, multi-step execution guidelines
│       │   └── security.ts                 # Safety guardrails and execution permission constraints
│       ├── mcp/
│       │   └── manager.ts                  # Model Context Protocol (MCP) server lifecycle and tool bridge
│       ├── commands/
│       │   └── registry.ts                 # Internal slash-command registration and dispatch registry
│       └── tools/
│           ├── registry.ts                 # Tool discovery, validation, and registration registry
│           ├── definitions.ts              # Tool parameter schema definitions and interfaces
│           ├── execTarget.ts               # Remote/container execution target abstraction (host vs docker)
│           ├── bashGuard.ts                # Command blocklist and dangerous bash command inspection
│           ├── bashRedirect.ts             # Redirection and piping handlers for sandboxed bash commands
│           └── defs/                       # Built-in tool implementations
│               ├── askUser.ts              # ask_user tool: prompts user interactively for clarification
│               ├── bash.ts                 # bash tool: executes terminal commands with timeout & guard
│               ├── createSkill.ts          # create_skill tool: dynamically generates custom skills
│               ├── edit.ts                 # edit tool: targeted find-and-replace file editing
│               ├── glob.ts                 # glob tool: fast file search matching pattern wildcards
│               ├── grep.ts                 # grep tool: regex and string search within file contents
│               ├── list.ts                 # list tool: directory listing with file metadata
│               ├── memory.ts               # memory tool: persistent key-value memory across sessions
│               ├── planWrite.ts            # plan_write tool: persists structured execution plans
│               ├── read.ts                 # read tool: chunk-based, line-ranged file reader
│               └── tasks.ts                # tasks tool: manages long-running background tasks
└── resources/                              # Skill management, prompt templates, and resource scaffolding
    └── src/
        ├── index.ts                        # Main export barrel for @tiny-cli/resources
        ├── types.ts                        # Skill, prompt template, and resource type definitions
        ├── discover.ts                     # File system scanner discovering skills and prompts
        ├── parse.ts                        # Parser for markdown-based SKILL.md and metadata frontmatter
        ├── prompt.ts                       # Template interpolation engine for system and user prompts
        └── scaffold.ts                     # Scaffolding generator creating new skill directory structures
```

## Quick Reference / One-Liners

- [`packages/cli/src/index.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/cli/src/index.ts) - Main CLI entrypoint that configures options and starts the interactive TUI.
- [`packages/cli/src/config.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/cli/src/config.ts) - Manages user configuration, environment variables, and model defaults.
- [`packages/cli/src/tui/app.tsx`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/cli/src/tui/app.tsx) - Top-level React container orchestrating terminal layouts, message streams, and input.
- [`packages/cli/src/tui/state.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/cli/src/tui/state.ts) - Central state store managing messages, active tool calls, and UI status flags.
- [`packages/cli/src/tui/keybindings.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/cli/src/tui/keybindings.ts) - Defines keyboard shortcuts for navigation, history traversal, and command triggering.
- [`packages/core/src/agent.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/agent.ts) - Core agent control loop driving iterative prompt generation, LLM reasoning, and tool dispatch.
- [`packages/core/src/agent/toolExecution.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/agent/toolExecution.ts) - Validates, invokes, and handles concurrency for tool calls requested by the model.
- [`packages/core/src/agent/compaction.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/agent/compaction.ts) - Automatically summarizes or prunes conversation history to preserve context budget.
- [`packages/core/src/model/client.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/model/client.ts) - Unified provider client connecting to Gemini, Anthropic, OpenAI, and custom endpoints.
- [`packages/core/src/tools/registry.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/registry.ts) - Central registry managing tool registration, schema retrieval, and capability filtering.
- [`packages/core/src/tools/execTarget.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/execTarget.ts) - Manages execution environment targeting (local host vs remote/docker container).
- [`packages/core/src/tools/bashGuard.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/bashGuard.ts) - Security guard evaluating bash commands against dangerous patterns before execution.
- [`packages/core/src/tools/defs/bash.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/defs/bash.ts) - Executes terminal shell commands within timeout and execution target limits.
- [`packages/core/src/tools/defs/read.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/defs/read.ts) - Reads file slices by line number to prevent massive context consumption.
- [`packages/core/src/tools/defs/edit.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/defs/edit.ts) - Performs targeted search-and-replace text modifications on workspace files.
- [`packages/core/src/tools/defs/grep.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/tools/defs/grep.ts) - Rapidly searches file contents using regex/patterns without reading entire files.
- [`packages/core/src/mcp/manager.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/core/src/mcp/manager.ts) - Starts, connects, and translates MCP server tools into native agent tools.
- [`packages/resources/src/discover.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/resources/src/discover.ts) - Scans file directories to discover available custom skills and prompt templates.
- [`packages/resources/src/parse.ts`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/packages/resources/src/parse.ts) - Extracts frontmatter and markdown documentation from skill definition files.

