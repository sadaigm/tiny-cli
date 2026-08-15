import type { ToolCall } from '@tiny-cli/core';

/** Execution mode — determines which tools and system prompt the agent uses. */
export type TuiMode = 'agent' | 'chat' | 'plan';

/** High-level lifecycle state of the agent within the TUI. */
export type AgentState = 'idle' | 'running' | 'awaiting_approval' | 'error';

/** Category of a single log entry, used for coloring and icon selection. */
export type LogEntryType =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'error'
  | 'info';

/**
 * A single entry in the message log.
 * Each user prompt, agent response, tool call, tool result, or system
 * message is represented as one LogEntry.
 */
export interface LogEntry {
  /** Unique identifier (used as React key). */
  id: string;
  /** Determines icon and color when rendered. */
  type: LogEntryType;
  /** Primary text content of the entry. */
  content: string;
  /** Tool name (for tool_call / tool_result entries). */
  toolName?: string;
  /** Raw JSON arguments string (for tool_call entries). */
  toolArgs?: string;
  /** Tool execution output (for tool_result entries). */
  toolResult?: string;
  /** Timing information from the agent step. */
  timing?: {
    modelChatMs?: number;
    toolCallMs?: number;
  };
  /** Epoch milliseconds when the entry was created. */
  timestamp: number;
  /** True if the message was submitted while the agent was busy (queued). */
  queued?: boolean;
}

/** Token and character counts for the status bar context display. */
export interface ContextStats {
  tokens: number;
  characters: number;
}

/**
 * The kind of inline selector overlay currently active.
 *
 * - `model`    — choose an LLM model from `fetchModels()`.
 * - `mode`     — choose a permission mode (notify/auto-edit/auto).
 * - `session`  — choose a saved session to load.
 */
export type SelectorKind = 'model' | 'mode' | 'session' | 'mcp';

/**
 * State for the inline AutocompletePopover overlay used by
 * `/model`, `/mode`, and `/session` slash commands.
 *
 * The overlay is rendered above the input box. The parent component
 * handles arrow-key navigation, Enter to accept, and Escape to dismiss.
 */
export interface PendingSelector {
  /** Which selector is open (determines the accept handler). */
  kind: SelectorKind;
  /** Title shown in the popover header. */
  title: string;
  /** Selectable items (plain strings). */
  items: string[];
  /** Zero-based index of the currently highlighted item. */
  selectedIndex: number;
}

/**
 * Information about a plan-execution task that was NOT marked as complete
 * by the agent, requiring user intervention via the recovery modal.
 */
export interface PendingRecovery {
  /** Zero-based index of the task within the incomplete-task list. */
  taskIndex: number;
  /** The raw task text (e.g. `` `- [ ] Do something` ``). */
  taskText: string;
  /** Total number of incomplete tasks in the plan. */
  totalTasks: number;
}

/**
 * The complete TUI state owned by the root <App> component.
 * Managed via useReducer in app.tsx.
 */
export interface TuiState {
  /** Current agent lifecycle phase. */
  agentState: AgentState;
  /** Active execution mode. */
  mode: TuiMode;
  /** Ordered list of log entries (newest appended at end). */
  log: LogEntry[];
  /** Tool call awaiting user approval, or null when none pending. */
  pendingApproval: ToolCall | null;
  /** Messages submitted while agent was busy, waiting to be processed. */
  messageQueue: string[];
  /** Text displayed next to the spinner while running. */
  spinnerText: string;
  /** Whether the autocomplete popover is currently visible. */
  showAutocomplete: boolean;
  /** Filtered items currently shown in the autocomplete popover. */
  autocompleteItems: string[];
  /** Index of the highlighted item in the autocomplete popover. */
  autocompleteSelected: number;
  /** Context window statistics for the status bar. */
  contextStats: ContextStats;
  /** Plan-execution recovery modal data, or null when no recovery needed. */
  pendingRecovery: PendingRecovery | null;
  /** True when plan execution is actively running. */
  planExecuting: boolean;
  /** Inline selector overlay state, or null when no overlay is open. */
  pendingSelector: PendingSelector | null;
  /** Whether mouse-wheel scrolling of the conversation pane is enabled. */
  mouseEnabled: boolean;
}
