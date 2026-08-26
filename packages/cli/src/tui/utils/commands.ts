/**
 * Catalog of interactive slash commands shown in the `/` command picker.
 *
 * The picker (in {@link InputBox}) mirrors the `@file`-mention picker: typing
 * `/` opens this list, further characters filter it, and Enter/Tab runs the
 * selected command via `onSubmit('/name')`, which routes through
 * `handleSlashCommand` in `app.tsx`.
 *
 * Keep this list in sync with the `switch (cmd)` cases in `app.tsx`.
 */
export interface SlashCommand {
  /** Command name (without the leading `/`). */
  name: string;
  /** One-line description shown dimmed in the picker. */
  description: string;
  /** When true, the picker inserts `/name ` for completion instead of running it bare. */
  takesArgs?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'agent', description: 'Switch to autonomous agent mode' },
  { name: 'chat', description: 'Switch to conversational chat mode (no tools)' },
  { name: 'plan', description: 'Switch to read-only planning mode' },
  { name: 'model', description: 'Select a different LLM model' },
  { name: 'mode', description: 'Switch permission mode (notify / auto-edit / auto)' },
  { name: 'tools', description: 'List available tools for the current mode' },
  { name: 'session', description: 'List, load, or create a session' },
  { name: 'mcp', description: 'Manage MCP server connections' },
  { name: 'continue', description: 'Continue executing the active plan' },
  { name: 'find', description: 'Search messages and jump to matches (/find <text>)', takesArgs: true },
  { name: 'queue', description: 'Show queued messages (/queue clear drops them)' },
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'compact', description: 'Summarize old history to shrink context now' },
  { name: 'mouse', description: 'Toggle mouse-wheel scrolling on/off' },
  { name: 'skills', description: 'List loaded skills and warnings' },
  { name: 'create-skill', description: 'Scaffold a new skill (/create-skill <description>)', takesArgs: true },
  { name: 'help', description: 'List commands and keyboard shortcuts' },
  { name: 'exit', description: 'Save session and quit' },
];
