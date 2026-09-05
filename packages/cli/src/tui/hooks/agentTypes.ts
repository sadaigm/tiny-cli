import type { MutableRefObject } from 'react';
import type { ToolCall } from '@tiny-cli/core';
import type { SessionManager, AskUserResponse } from '@tiny-cli/core';
import type { TuiMode, LogEntryType, PendingQuestionnaire, PendingRecovery, PendingPlanConfirm } from '../state.js';
import type { MessageQueue } from '../utils/messageQueue.js';
import type { Deferred } from '../utils/deferred.js';

/**
 * Shared types + constants for the useAgent hook family
 * (useAgent.ts facade + runTurn/approvals/planExecution/sessionSync
 * modules). Split out of useAgent.ts — mechanical move, no behavior change.
 */

/**
 * Minimum turn duration (ms) before a completion bell fires — quick
 * replies don't need to chirp, only turns long enough that the user may
 * have tabbed away.
 */
export const BELL_MIN_TURN_MS = 10_000;

/**
 * A partial log entry that the consumer fills with `id` and `timestamp`
 * before adding to the log array.
 */
export interface NewLogEntry {
  type: LogEntryType;
  content: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  timing?: { modelChatMs?: number; toolCallMs?: number };
  queued?: boolean;
  /** True while this entry is actively streaming (live reasoning). */
  live?: boolean;
  /**
   * Pre-reserved entry id (from the App's `reserveLogId`), used for the
   * live streaming assistant entry so later deltas can find it.
   */
  _id?: string;
}

/**
 * The user's choice when asked to approve a tool call.
 *
 * - `'approve'` — run this single tool call.
 * - `'approve-session'` — switch permission mode to `'auto'` for the
 *   remainder of the session and run this call.
 * - `'cancel'` — skip this call (agent receives a denial message).
 * - `'abort'` — abort the entire agent turn via `AbortController`.
 */
export type ApprovalChoice = 'approve' | 'approve-session' | 'cancel' | 'abort';

/**
 * Choices available when a plan-execution task is not marked as complete
 * by the agent.  Shown in the `RecoveryModal`.
 *
 * - `'retry'`   — Re-run the current task.
 * - `'manual'`  — Manually mark the task as complete in the task file.
 * - `'skip'`    — Skip this task and move to the next one.
 * - `'stop'`    — Abort plan execution entirely.
 */
export type RecoveryChoice = 'retry' | 'manual' | 'skip' | 'stop';

/**
 * Imperative state patcher provided by the parent `<App>` component.
 * The hook calls this to update `agentState`, `spinnerText`,
 * `pendingApproval`, `contextStats`, and the message-queue display.
 */
export interface UseAgentSetState {
  (patch: UseAgentStatePatch): void;
}

/** Subset of `TuiState` that the hook is allowed to mutate. */
export interface UseAgentStatePatch {
  agentState?: 'idle' | 'running' | 'awaiting_approval' | 'error';
  spinnerText?: string;
  pendingApproval?: ToolCall | null;
  pendingQuestions?: PendingQuestionnaire | null;
  messageQueue?: string[];
  contextStats?: { tokens: number; characters: number };
  pendingRecovery?: PendingRecovery | null;
  planExecuting?: boolean;
  pendingPlanConfirm?: PendingPlanConfirm | null;
}

/** Callback the hook calls whenever a new log entry is produced. */
export type AddLogFn = (entry: NewLogEntry) => void;

/** Callback the hook calls when it needs the current mode. */
export type GetModeFn = () => TuiMode;

/**
 * The mutable refs the hook family shares. Created once in the
 * {@link useAgent} facade and passed explicitly to each module — no
 * React contexts.
 */
export interface AgentRefs {
  /** Message queue for messages submitted while agent is busy. */
  queueRef: MutableRefObject<MessageQueue>;
  /** AbortController for the current agent turn (recreated per turn). */
  abortRef: MutableRefObject<AbortController | null>;
  /** Deferred promise for the current approval modal, if any. */
  approvalDeferredRef: MutableRefObject<Deferred<ApprovalChoice> | null>;
  /** Deferred promise for the current recovery modal, if any. */
  recoveryDeferredRef: MutableRefObject<Deferred<RecoveryChoice> | null>;
  /** Deferred promise for the plan-execute confirm modal, if any. */
  planConfirmDeferredRef: MutableRefObject<Deferred<boolean> | null>;
  /** Deferred promise for the current questionnaire modal, if any. */
  questionnaireDeferredRef: MutableRefObject<Deferred<AskUserResponse> | null>;
  /**
   * Latest `executePlan` — lets `runAgentTurn` call it without a
   * circular dependency in the callback chain.
   */
  executePlanRef: MutableRefObject<() => void>;
  /** Whether plan execution is currently active (ref for synchronous reads). */
  planExecutingRef: MutableRefObject<boolean>;
  /**
   * Tracks whether an agent turn is currently in-flight.  A ref (not
   * React state) because `submitMessage` and `runAgentTurn` need to read
   * the value synchronously without stale-closure issues; the React
   * `agentState` state is updated separately for rendering.
   */
  isRunningRef: MutableRefObject<boolean>;
}

/** Props for the {@link useAgent} hook. */
export interface UseAgentProps {
  /** The initialised Agent instance (already has `.init()` called). */
  agent: import('@tiny-cli/core').Agent;
  /** SessionManager for persisting conversation history. */
  sessionManager: SessionManager;
  /** Session ID for save/load operations. */
  sessionId: string;
  /** Imperative state patcher. */
  setState: UseAgentSetState;
  /** Called for every new log entry (tool calls, results, assistant text…). */
  addLog: AddLogFn;
  /** Returns the current execution mode at call-time. */
  getMode: GetModeFn;
  /** Switches the active execution mode (e.g. plan → agent after executing). */
  setMode: (mode: TuiMode) => void;
  /**
   * External store for live streaming content. Thinking/response deltas
   * are concatenated here (re-rendering only the small subscribed
   * panels), and committed back via addLog once when each phase ends.
   */
  streamStore: import('../streamStore.js').StreamStore;
}

/**
 * The public API returned by `useAgent`.
 */
export interface UseAgentApi {
  /**
   * Submit a user message.
   *
   * If the agent is idle, runs the turn immediately (fire-and-forget).
   * If the agent is busy, the message is queued and processed after the
   * current turn completes.
   */
  submitMessage: (text: string, displayText?: string) => void;
  /** Abort the current agent turn via `AbortController`. */
  abortCurrentRun: () => void;
  /**
   * Discard every queued (not yet started) message.
   *
   * The in-flight turn, if any, is unaffected — only messages waiting in
   * the queue are dropped. Used by `/queue clear`.
   */
  clearQueue: () => void;
  /** Resolve the pending approval modal with the user's choice. */
  resolveApproval: (choice: ApprovalChoice) => void;
  /** Resolve the pending questionnaire modal with the user's answers. */
  resolveQuestionnaire: (response: AskUserResponse) => void;
  /**
   * Execute the active plan: iterate over incomplete tasks, run each
   * through the agent, and handle recovery when tasks aren't marked done.
   */
  executePlan: () => void;
  /** Resolve the pending recovery modal with the user's choice. */
  resolveRecovery: (choice: RecoveryChoice) => void;
  /** Resolve the pending plan-execute confirm modal with the user's choice. */
  resolvePlanConfirm: (execute: boolean) => void;
}
