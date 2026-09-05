import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Agent, AskUserResponse } from '@tiny-cli/core';
import { logError, logDebug } from '@tiny-cli/core';
import { MessageQueue } from '../utils/messageQueue.js';
import { createDeferred, type Deferred } from '../utils/deferred.js';
import type {
  AgentRefs,
  ApprovalChoice,
  RecoveryChoice,
  UseAgentApi,
  UseAgentProps,
} from './agentTypes.js';
import { createSaveSession, wireAgentEvents } from './sessionSync.js';
import { createApprovals } from './approvals.js';
import { createRunTurn } from './runTurn.js';
import { createPlanExecution } from './planExecution.js';

export type {
  NewLogEntry,
  ApprovalChoice,
  RecoveryChoice,
  UseAgentSetState,
  UseAgentStatePatch,
  AddLogFn,
  GetModeFn,
  UseAgentProps,
  UseAgentApi,
} from './agentTypes.js';

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
 * Key mechanisms (each in its own module under `hooks/`):
 *
 * - **Message queue** — a `MessageQueue` holds messages submitted
 *   while the agent is running.  After each turn, the queue is drained
 *   recursively (`runTurn.ts`).
 * - **Abort** — an `AbortController` is recreated for each turn;
 *   `abortCurrentRun()` calls `.abort()` on it.
 * - **Approval modal** — `agent.run()`'s `onApproval` callback creates
 *   a `Deferred` promise, sets `pendingApproval` state, and awaits the
 *   promise (`approvals.ts`).
 * - **Plan execution** — the task-file loop with recovery modals
 *   (`planExecution.ts`).
 * - **Session save** — after each turn, `agent.getHistory()` is
 *   persisted via `SessionManager` (`sessionSync.ts`).
 *
 * The shared mutable refs live here and are passed explicitly to the
 * modules (no React contexts).
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
  setMode,
  streamStore,
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

  /** Deferred promise for the plan-execute confirm modal, if any. */
  const planConfirmDeferredRef = useRef<Deferred<boolean> | null>(null);

  /** Deferred promise for the current questionnaire modal, if any. */
  const questionnaireDeferredRef = useRef<Deferred<AskUserResponse> | null>(null);

  /**
   * Latest `executePlan` — lets `runAgentTurn` call it without a
   * circular dependency in the callback chain.
   */
  const executePlanRef = useRef<() => void>(() => {});

  /** Whether plan execution is currently active (ref for synchronous reads). */
  const planExecutingRef = useRef(false);

  /**
   * Tracks whether an agent turn is currently in-flight.  We use a ref
   * (not React state) because `submitMessage` and `runAgentTurn` need
   * to read the value synchronously without stale-closure issues, and
   * the React `agentState` state is updated separately for rendering.
   */
  const isRunningRef = useRef(false);

  // One stable AgentRefs bundle for the hook modules.
  const refsRef = useRef<AgentRefs | null>(null);
  if (!refsRef.current) {
    refsRef.current = {
      queueRef,
      abortRef,
      approvalDeferredRef,
      recoveryDeferredRef,
      planConfirmDeferredRef,
      questionnaireDeferredRef,
      executePlanRef,
      planExecutingRef,
      isRunningRef,
    };
  }
  const refs = refsRef.current;

  // ── Real-time context stats & visible compaction ────────────────

  // Recompute stats after every message appended to the agent's history,
  // and surface compactions as a system log line.
  useEffect(() => wireAgentEvents(agent, setState, addLog), [agent, setState, addLog]);

  // ── Module wiring ───────────────────────────────────────────────

  const saveSession = useMemo(
    () => createSaveSession({ agent, sessionManager, sessionId, setState }),
    [agent, sessionManager, sessionId, setState],
  );

  const { showApprovalModal, showQuestionnaire, resolveApproval, resolveQuestionnaire } = useMemo(
    () => createApprovals({ setState, refs }),
    // refs is a stable bundle (same object every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setState, refs],
  );

  const runAgentTurn = useMemo(
    () =>
      createRunTurn({
        agent,
        sessionManager,
        sessionId,
        setState,
        addLog,
        getMode,
        setMode,
        streamStore,
        refs,
        showApprovalModal,
        showQuestionnaire,
        saveSession,
      }),
    // Mirrors the original useCallback dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent, setState, addLog, getMode, setMode, streamStore, showApprovalModal, saveSession, sessionManager, sessionId, refs],
  );

  const { executePlan, resolveRecovery, resolvePlanConfirm } = useMemo(
    () => createPlanExecution({ sessionId, setState, addLog, runAgentTurn, refs }),
    // Mirrors the original useCallback dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, addLog, setState, runAgentTurn, refs],
  );

  // Keep the ref pointing at the latest executePlan so runAgentTurn
  // (defined above it) can call it without a circular useCallback dep.
  executePlanRef.current = executePlan;

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
        runAgentTurn(trimmed).catch((e) => logDebug(`[trace] runAgentTurn (submit) unhandled: name=${(e as Error)?.name} message=${(e as Error)?.message}`));
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
      logDebug('[trace] abortCurrentRun: abort triggered');
      try {
        abortRef.current.abort();
      } catch (err: unknown) {
        // An abort listener can throw synchronously (e.g. node-fetch emits
        // 'error' on the body stream when no listener is attached yet) —
        // that must not escape into the key handler / unhandledRejection.
        logError(`abortCurrentRun: abort() threw: ${(err as Error)?.name}: ${(err as Error)?.message}\n${(err as Error)?.stack ?? ''}`);
      }
      logDebug('[trace] abortCurrentRun: abort() returned cleanly');
    }
  }, []);

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
    resolveQuestionnaire,
    executePlan,
    resolveRecovery,
    resolvePlanConfirm,
  };
}
