import { useCallback, useRef } from 'react';
import type { Agent, AgentStep, SessionManager, ToolCall } from '@tiny-cli/core';
import { logError } from '@tiny-cli/core';
import type {
  TuiMode,
  LogEntry,
  LogEntryType,
  PendingRecovery,
} from '../state.js';
import {
  MessageQueue,
} from '../utils/messageQueue.js';
import {
  createDeferred,
  type Deferred,
} from '../utils/deferred.js';
import {
  readPlanTaskFile,
  writePlanTaskFile,
  readPlanFile,
  parseIncompleteTasks,
  isTaskMarkedComplete,
  markTaskCompleteInContent,
} from '../utils/planReader.js';

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Minimum turn duration (ms) before a completion bell fires — quick
 * replies don't need to chirp, only turns long enough that the user may
 * have tabbed away.
 */
const BELL_MIN_TURN_MS = 10_000;
/** Live reasoning streams expanded up to this many lines, then auto-collapses. */
const MAX_LIVE_REASONING_LINES = 3;

// ─── Types ─────────────────────────────────────────────────────────

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
 * by the agent.  Shown in the {@link RecoveryModal}.
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
  messageQueue?: string[];
  contextStats?: { tokens: number; characters: number };
  pendingRecovery?: PendingRecovery | null;
  planExecuting?: boolean;
}

/** Callback the hook calls whenever a new log entry is produced. */
export type AddLogFn = (entry: NewLogEntry) => void;

/** Callback the hook calls when it needs the current mode. */
export type GetModeFn = () => TuiMode;

// ─── Hook ──────────────────────────────────────────────────────────

/**
 * Props for the {@link useAgent} hook.
 */
export interface UseAgentProps {
  /** The initialised Agent instance (already has `.init()` called). */
  agent: Agent;
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
  /**
   * Append a text delta to an existing log entry — used to stream the
   * live assistant message as `run()`'s `onText` deltas arrive. Optional;
   * without it, the final text still lands as one entry after the turn.
   */
  appendLogText?: (id: string, delta: string) => void;
  /**
   * Pre-assign the id for the next log entry, so a streaming assistant
   * entry can be created empty and appended to by id. Returns the id the
   * ADD_LOG reducer will use. Optional (no streaming without it).
   */
  reserveLogId?: () => string;
  /**
   * Flip an existing log entry's `live` flag (used to collapse the live
   * reasoning entry once the turn moves past the thinking phase).
   */
  setLogLive?: (id: string, live: boolean) => void;
}

/**
 * The public API returned by {@link useAgent}.
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
  /**
   * Execute the active plan: iterate over incomplete tasks, run each
   * through the agent, and handle recovery when tasks aren't marked done.
   */
  executePlan: () => void;
  /** Resolve the pending recovery modal with the user's choice. */
  resolveRecovery: (choice: RecoveryChoice) => void;
}

/**
 * Core agent lifecycle hook implementing the **concurrent execution
 * model**.
 *
 * The central design principle is that `agent.run()` is launched as a
 * **fire-and-forget background task** — it is never awaited by the
 * React render cycle.  This lets the `<InputBox>` stay interactive
 * while the agent works, with messages either executing immediately
 * (idle) or being queued (busy).
 *
 * Key mechanisms:
 *
 * - **Message queue** — a {@link MessageQueue} holds messages submitted
 *   while the agent is running.  After each turn, the queue is drained
 *   recursively.
 * - **Abort** — an `AbortController` is recreated for each turn;
 *   `abortCurrentRun()` calls `.abort()` on it.
 * - **Approval modal** — `agent.run()`'s `onApproval` callback creates
 *   a {@link Deferred} promise, sets `pendingApproval` state, and
 *   awaits the promise.  The UI calls `resolveApproval()` to settle it.
 * - **Session save** — after each turn, `agent.getHistory()` is
 *   persisted via {@link SessionManager}.
 *
 * @example
 * ```tsx
 * const api = useAgent({ agent, sessionManager, sessionId, setState, addLog, getMode });
 *
 * // In InputBox onSubmit:
 * api.submitMessage(text);
 *
 * // On Escape:
 * api.abortCurrentRun();
 *
 * // In ApprovalModal:
 * api.resolveApproval('approve');
 * ```
 */
export function useAgent({
  agent,
  sessionManager,
  sessionId,
  setState,
  addLog,
  getMode,
  appendLogText,
  reserveLogId,
  setLogLive,
}: UseAgentProps): UseAgentApi {
  // ── Refs (persist across renders without triggering re-render) ──

  /** Message queue for messages submitted while agent is busy. */
  const queueRef = useRef(new MessageQueue());

  /** AbortController for the current agent turn (recreated per turn). */
  const abortRef = useRef<AbortController | null>(null);

  /** Deferred promise for the current approval modal, if any. */
  const approvalDeferredRef = useRef<Deferred<ApprovalChoice> | null>(null);

  /** Deferred promise for the current recovery modal, if any. */
  const recoveryDeferredRef = useRef<Deferred<RecoveryChoice> | null>(null);

  /** Whether plan execution is currently active (ref for synchronous reads). */
  const planExecutingRef = useRef(false);

  /**
   * Tracks whether an agent turn is currently in-flight.  We use a ref
   * (not React state) because `submitMessage` and `runAgentTurn` need
   * to read the value synchronously without stale-closure issues, and
   * the React `agentState` state is updated separately for rendering.
   */
  const isRunningRef = useRef(false);

  // ── Internal helpers ────────────────────────────────────────────

  /**
   * Persist the agent's conversation history and update context stats.
   */
  const saveSession = useCallback(async (): Promise<void> => {
    try {
      const messages = agent.getHistory();
      const session = await sessionManager.loadSession(sessionId);
      if (session) {
        session.messages = messages;
        session.metadata.lastUpdatedAt = new Date().toISOString();
        await sessionManager.saveSession(session);
      }
    } catch {
      // Session save failure is non-fatal
    }

    // Update context stats for the status bar
    try {
      const stats = agent.getContextStats();
      setState({ contextStats: stats });
    } catch {
      // ignore
    }
  }, [agent, sessionManager, sessionId, setState]);

  /**
   * Display the approval modal and return the user's decision via a
   * deferred promise.
   *
   * Called synchronously by `agent.run()`'s `onApproval` callback.
   * Sets `pendingApproval` state so the `<ApprovalModal>` renders,
   * then awaits `approvalDeferredRef.current.promise`.  The UI calls
   * `resolveApproval()` to settle the promise.
   */
  const showApprovalModal = useCallback(
    async (call: ToolCall): Promise<ApprovalChoice> => {
      const deferred = createDeferred<ApprovalChoice>();
      approvalDeferredRef.current = deferred;

      setState({
        agentState: 'awaiting_approval',
        pendingApproval: call,
      });

      const result = await deferred.promise;

      setState({
        agentState: 'running',
        pendingApproval: null,
      });

      return result;
    },
    [setState],
  );

  /**
   * Run a single agent turn.
   *
   * This is an async function that runs as a **background task** — it
   * is never awaited by the React render cycle.  It:
   *
   * 1. Creates a fresh `AbortController`.
   * 2. Calls `agent.run()` with `onStep` (stream to log) and
   *    `onApproval` (deferred-promise modal) callbacks.
   * 3. Logs the assistant response.
   * 4. Persists the session.
   * 5. Drains the queue: if there are queued messages, runs the next
   *    one recursively; otherwise returns to idle.
   *
   * Errors are caught, logged, and the agent returns to idle.
   */
  const runAgentTurn = useCallback(
    async (input: string, spinnerPrefix?: string): Promise<void> => {
      const turnStartedAt = Date.now();
      isRunningRef.current = true;
      const abortController = new AbortController();
      abortRef.current = abortController;
      const mode = planExecutingRef.current ? 'agent' : getMode();

      setState({
        agentState: 'running',
        spinnerText: spinnerPrefix ? `${spinnerPrefix}…` : 'Thinking…',
      });

      // Shared with onReasoning below: the id of the live reasoning entry
      // for this turn, so onStep and the turn-end/error paths can collapse
      // it once the thinking phase is over (or it exceeds the line budget).
      let liveReasoningId: string | null = null;
      let reasoningCollapsed = false;
      let reasoningBuf = '';
      const collapseReasoning = (): void => {
        if (liveReasoningId !== null && !reasoningCollapsed) {
          reasoningCollapsed = true;
          setLogLive?.(liveReasoningId, false);
          liveReasoningId = null; // Clear immediately to prevent double-collapse
        }
      };

      try {
        // onStep — stream tool calls / results to the log immediately
        const onStep = (step: AgentStep): void => {
          if (step.toolCall) {
            // Tool execution begins — the thinking phase is over, collapse
            // the live reasoning entry.
            collapseReasoning();
            addLog({
              type: 'tool_call',
              content: step.toolCall.function.name,
              toolName: step.toolCall.function.name,
              toolArgs: step.toolCall.function.arguments,
              timing: step.timing,
            });

            if (step.toolResult !== undefined) {
              addLog({
                type: 'tool_result',
                content: step.toolResult,
                toolResult: step.toolResult,
                toolName: step.toolCall.function.name,
                timing: step.timing,
              });
            }

            setState({ spinnerText: spinnerPrefix ? `${spinnerPrefix}…` : 'Working…' });
          }
        };

        // onApproval — show modal, await user decision
        const onApproval = async (call: ToolCall): Promise<boolean> => {
          const decision = await showApprovalModal(call);

          if (decision === 'approve') {
            return true;
          }
          if (decision === 'approve-session') {
            // Switch to auto mode for the rest of the session
            const config = agent.getConfig();
            agent.updateConfig({ ...config, permissionMode: 'auto' });
            try {
              const session = await sessionManager.loadSession(sessionId);
              if (session) {
                session.metadata.permissionMode = 'auto';
                await sessionManager.saveSession(session);
              }
            } catch {
              // non-fatal
            }
            return true;
          }
          if (decision === 'abort') {
            abortController.abort();
          }
          // 'cancel' or 'abort' → deny
          return false;
        };

        // onText — stream assistant text into a live log entry. The entry
        // is created lazily on the first delta (empty assistant message),
        // then grown via appendLogText. If streaming isn't available (no
        // callback wired, or the stream fell back to buffered), the final
        // response below still lands as a normal entry.
        let liveEntryId: string | null = null;
        let streamedAnything = false;
        // Live reasoning entry: `live` keeps it expanded while it streams;
        // the flag is cleared as soon as the turn moves past the thinking
        // phase (first text delta or tool call) so it collapses in place.
        const onText = (delta: string): void => {
          if (!appendLogText || !reserveLogId) return;
          if (liveReasoningId !== null) {
            collapseReasoning();
          }
          if (liveEntryId === null) {
            liveEntryId = reserveLogId();
            addLog({ type: 'assistant', content: '', _id: liveEntryId } as NewLogEntry);
          }
          streamedAnything = true;
          appendLogText(liveEntryId, delta);
        };

        // onReasoning — stream the model's thinking into its own dimmed
        // live entry, separate from the assistant text entry.
        const onReasoning = (delta: string): void => {
          if (!appendLogText || !reserveLogId) return;
          if (liveReasoningId === null) {
            liveReasoningId = reserveLogId();
            reasoningBuf = '';
            addLog({ type: 'reasoning', content: '', _id: liveReasoningId, live: true } as NewLogEntry);
          }
          appendLogText(liveReasoningId, delta);
          // Auto-collapse once the thinking exceeds the line budget — a
          // long reasoning stream shouldn't flood the pane while it runs.
          reasoningBuf += delta;
          if (reasoningBuf.split('\n').length > MAX_LIVE_REASONING_LINES) {
            collapseReasoning();
          }
          setState({ spinnerText: 'Thinking…' });
        };

        const response = await agent.run(
          input,
          onStep,
          mode,
          true, // continueSession
          abortController.signal,
          onApproval,
          onText,
          onReasoning,
        );

        // Log the final assistant response (if non-empty). When the whole
        // text already streamed into the live entry, re-adding the blob
        // would duplicate it — skip unless the stream produced nothing
        // (fallback path) or the final content is new.
        if (
          response.content &&
          response.content.trim() &&
          !(response.streamedFinal && streamedAnything)
        ) {
          addLog({
            type: 'assistant',
            content: response.content,
          });
        }

        // Persist session history
        await saveSession();

        // Safety net: agent.run can return early (abort, timeout) without
        // firing onStep/onText — make sure the reasoning entry is collapsed.
        collapseReasoning();
        liveReasoningId = null;

        // ── Queue drain ──────────────────────────────────────────
        const nextMessage = queueRef.current.dequeue();
        if (nextMessage) {
          // Update queue display
          setState({ messageQueue: queueRef.current.toArray() });
          // Log the de-queued message (no longer "queued" tag)
          addLog({
            type: 'user',
            content: nextMessage,
          });
          // Recurse to run the next turn
          await runAgentTurn(nextMessage, spinnerPrefix);
        } else {
          isRunningRef.current = false;
          setState({
            agentState: 'idle',
            spinnerText: '',
            messageQueue: [],
          });
          // Terminal bell: long turns often finish while the user has
          // tabbed away — BEL snaps the tab/title indicator. Fire only
          // after a meaningful run so quick replies don't chirp.
          if (Date.now() - turnStartedAt >= BELL_MIN_TURN_MS) {
            process.stdout.write('\x07');
          }
        }
      } catch (err: unknown) {
        collapseReasoning();
        const message = err instanceof Error ? err.message : String(err);
        logError(`agent turn failed: ${message}\n${err instanceof Error ? err.stack ?? '' : ''}`);
        addLog({
          type: 'error',
          content: message,
        });
        isRunningRef.current = false;
        setState({
          agentState: 'idle',
          spinnerText: '',
          messageQueue: queueRef.current.toArray(),
        });
      }
    },
    [agent, setState, addLog, getMode, showApprovalModal, saveSession, sessionManager, sessionId],
  );

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Submit a user message.
   *
   * - **Agent idle** → log the message and start a new turn immediately.
   * - **Agent busy** → log the message with `queued: true`, enqueue it,
   *   and update the queue display.  It will be processed after the
   *   current turn drains the queue.
   */
  const submitMessage = useCallback(
    (text: string, displayText?: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // What the user saw in the input (e.g. "@path" mentions, not the
      // hydrated <file> blocks sent to the model).
      const display = displayText?.trim() || trimmed;

      if (isRunningRef.current) {
        // Agent is busy — queue the message
        queueRef.current.enqueue(trimmed);
        setState({ messageQueue: queueRef.current.toArray() });
        addLog({
          type: 'user',
          content: display,
          queued: true,
        });
      } else {
        // Agent is idle — run immediately (fire-and-forget)
        addLog({
          type: 'user',
          content: display,
        });
        // Fire-and-forget: do NOT await — keeps render cycle non-blocking
        void runAgentTurn(trimmed);
      }
    },
    [addLog, setState, runAgentTurn],
  );

  /**
   * Abort the current agent turn.
   *
   * Triggers the `AbortController` which causes `agent.run()` to
   * return early with a cancellation message.
   */
  const abortCurrentRun = useCallback((): void => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  /**
   * Resolve the pending approval modal.
   *
   * Called by `<ApprovalModal>` when the user selects an option.
   * Settles the deferred promise, unblocking `agent.run()`'s
   * `onApproval` callback.
   */
  const resolveApproval = useCallback(
    (choice: ApprovalChoice): void => {
      const deferred = approvalDeferredRef.current;
      if (deferred) {
        approvalDeferredRef.current = null;
        deferred.resolve(choice);
      }
    },
    [],
  );

  /**
   * Execute the active plan: iterate over incomplete tasks, run each
   * through the agent, and handle recovery when tasks aren't marked done.
   *
   * Ported from `executeActivePlan()` in `repl.ts`, adapted for the
   * Ink/React TUI.  Each task is run via `runAgentTurn` with a special
   * execution prompt, and tool approvals flow through the same
   * `showApprovalModal` deferred-promise mechanism.  After each turn,
   * the task file is re-read to check whether the agent called
   * `mark_task_complete`.  If not, a recovery modal is shown.
   *
   * The entire loop runs as a fire-and-forget background task — it
   * is never awaited by the render cycle.  The InputBox stays live
   * so the user can type while tasks execute.
   */
  const executePlan = useCallback((): void => {
    // Fire-and-forget async IIFE
    void (async (): Promise<void> => {
      if (planExecutingRef.current || isRunningRef.current) {
        addLog({
          type: 'system',
          content: 'Cannot start plan execution — agent is already busy.',
        });
        return;
      }

      const tasks = parseIncompleteTasks(await readPlanTaskFile(sessionId));
      if (tasks.length === 0) {
        addLog({
          type: 'system',
          content: 'No incomplete tasks found in the plan.',
        });
        return;
      }

      planExecutingRef.current = true;
      setState({ planExecuting: true });
      addLog({
        type: 'system',
        content: `Found ${tasks.length} pending tasks to execute.`,
      });

      const planContent = await readPlanFile(sessionId);
      let abortExecution = false;

      for (let i = 0; i < tasks.length; i++) {
        if (abortExecution) break;
        const task = tasks[i];
        addLog({
          type: 'system',
          content: `[Executing Task ${i + 1}/${tasks.length}] ${task.text}`,
        });

        // Retry loop for the same task
        let retry = true;
        while (retry && !abortExecution) {
          retry = false;

          const prompt = `You are in execution mode.
Your goal is to implement the task described below.

Your CURRENT task to implement is EXACTLY:
${task.raw}

Plan Context:
${planContent}

CRITICAL INSTRUCTIONS:
1. When you have successfully implemented and verified the task, you MUST call the 'mark_task_complete' tool.
2. If you do not call 'mark_task_complete', the task will be marked as FAILED or INCOMPLETE.
3. Only call 'mark_task_complete' if the code is actually written and tested.`;

          // Run the agent turn (fire-and-forget but we await inside this IIFE)
          await runAgentTurn(
            prompt,
            `Executing Task ${i + 1}/${tasks.length}`,
          );

          // Check abort
          if (abortRef.current?.signal.aborted) {
            abortExecution = true;
            break;
          }

          // Re-read the task file to check if task was marked complete
          const updatedContent = await readPlanTaskFile(sessionId);
          const isComplete = isTaskMarkedComplete(updatedContent, task.text);

          if (isComplete) {
            addLog({
              type: 'system',
              content: `Task ${i + 1}/${tasks.length} completed.`,
            });
          } else {
            // Show recovery modal
            const choice = await new Promise<RecoveryChoice>((resolve) => {
              const deferred = createDeferred<RecoveryChoice>();
              recoveryDeferredRef.current = deferred;
              setState({
                pendingRecovery: {
                  taskIndex: i,
                  taskText: task.raw,
                  totalTasks: tasks.length,
                },
              });
              deferred.promise.then(resolve);
            });

            setState({ pendingRecovery: null });

            switch (choice) {
              case 'retry':
                retry = true;
                break;
              case 'manual': {
                const manualContent = markTaskCompleteInContent(
                  await readPlanTaskFile(sessionId),
                  task.text,
                );
                await writePlanTaskFile(sessionId, manualContent);
                addLog({
                  type: 'system',
                  content: `Task ${i + 1}/${tasks.length} marked as done manually.`,
                });
                break;
              }
              case 'skip':
                addLog({
                  type: 'system',
                  content: `Task ${i + 1}/${tasks.length} skipped.`,
                });
                break;
              case 'stop':
                abortExecution = true;
                break;
            }
          }
        }
      }

      planExecutingRef.current = false;
      setState({ planExecuting: false });
      addLog({
        type: 'system',
        content: abortExecution
          ? 'Plan execution aborted.'
          : 'Plan execution finished.',
      });
    })();
  }, [sessionId, addLog, setState, runAgentTurn]);

  /**
   * Resolve the pending recovery modal.
   *
   * Called by `<RecoveryModal>` when the user selects an option.
   * Settles the deferred promise, unblocking `executePlan`.
   */
  const resolveRecovery = useCallback(
    (choice: RecoveryChoice): void => {
      const deferred = recoveryDeferredRef.current;
      if (deferred) {
        recoveryDeferredRef.current = null;
        deferred.resolve(choice);
      }
    },
    [],
  );

  /**
   * Discard every queued message. The in-flight turn keeps running.
   */
  const clearQueue = useCallback((): void => {
    if (queueRef.current.isEmpty) return;
    const dropped = queueRef.current.length;
    queueRef.current.clear();
    setState({ messageQueue: [] });
    addLog({
      type: 'system',
      content: `Dropped ${dropped} queued message${dropped !== 1 ? 's' : ''}.`,
    });
  }, [setState, addLog]);

  return {
    submitMessage,
    abortCurrentRun,
    clearQueue,
    resolveApproval,
    executePlan,
    resolveRecovery,
  };
}
