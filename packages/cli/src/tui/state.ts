import type { AskUserAnswer, AskUserPayload, ToolCall } from '@tiny-cli/core';
import type { AutocompleteItem } from './components/AutocompletePopover.js';

/** Execution mode — determines which tools and system prompt the agent uses. */
export type TuiMode = 'agent' | 'chat' | 'plan';

/** High-level lifecycle state of the agent within the TUI. */
export type AgentState = 'idle' | 'running' | 'awaiting_approval' | 'error';

/** Category of a single log entry, used for coloring and icon selection. */
export type LogEntryType =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'plan'
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
  /**
   * True while this entry is actively streaming (e.g. live reasoning).
   * A reasoning entry collapses to one line as soon as its phase ends,
   * even if the agent turn is still running.
   */
  live?: boolean;
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
export type SelectorKind = 'model' | 'mode' | 'session' | 'mcp' | 'mcp-action' | 'skill';

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
  /** Selectable items (plain strings or label/value/description objects). */
  items: AutocompleteItem[];
  /** Zero-based index of the currently highlighted item. */
  selectedIndex: number;
  /** Extra context for the accept handler (e.g. server name for 'mcp-action'). */
  context?: string;
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
 * Shown after a plan-mode turn completes: ask the user whether to
 * execute the freshly written plan (port of the old REPL's
 * "Execute this plan?" inquirer confirm).
 */
export interface PendingPlanConfirm {
  /** Number of incomplete tasks found in `current_task.md`. */
  taskCount: number;
}

/** Active questionnaire shown by <QuestionnaireModal/>. */
export interface PendingQuestionnaire {
  /** Questionnaire payload from the ask_user tool. */
  payload: AskUserPayload;
  /** Zero-based index of the question currently displayed. */
  currentIndex: number;
  /** Answers collected so far (index-aligned with payload.questions). */
  answers: AskUserAnswer[];
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
  /** Active questionnaire shown by <QuestionnaireModal/>, or null when none pending. */
  pendingQuestions: PendingQuestionnaire | null;
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
  /** Plan-execute confirm modal data, or null when none pending. */
  pendingPlanConfirm: PendingPlanConfirm | null;
  /** Inline selector overlay state, or null when no overlay is open. */
  pendingSelector: PendingSelector | null;
  /**
   * Runtime overrides applied by the session switcher (formerly a
   * `declare module` augmentation in app.tsx): when set they win over the
   * boot-time props from the initial config/session.
   */
  _config?: import('@tiny-cli/core').AgentConfig;
  _sessionId?: string;
  _permissionMode?: 'notify' | 'auto-edit' | 'auto';
}
