import type { Agent, AgentStep, ToolCall, SessionManager, AskUserPayload, AskUserResponse } from '@tiny-cli/core';
import { logError, logDebug } from '@tiny-cli/core';
import type { StreamStore } from '../streamStore.js';
import { createDeferred } from '../utils/deferred.js';
import { readPlanTaskFile, parseIncompleteTasks } from '../utils/planReader.js';
import type { AddLogFn, AgentRefs, ApprovalChoice, GetModeFn, UseAgentSetState } from './agentTypes.js';
import { BELL_MIN_TURN_MS } from './agentTypes.js';
import type { TuiMode as Mode } from '../state.js';

/**
 * runAgentTurn + queue drain + plan-confirm kick-off, split out of
 * useAgent.ts (mechanical move — body verbatim).
 *
 * Run a single agent turn.
 *
 * This is an async function that runs as a **background task** — it is
 * never awaited by the React render cycle.  It:
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
export type RunAgentTurnFn = (input: string, spinnerPrefix?: string) => Promise<void>;

export function createRunTurn(deps: {
  agent: Agent;
  sessionManager: SessionManager;
  sessionId: string;
  setState: UseAgentSetState;
  addLog: AddLogFn;
  getMode: GetModeFn;
  setMode: (mode: Mode) => void;
  streamStore: StreamStore;
  refs: AgentRefs;
  showApprovalModal: (call: ToolCall) => Promise<ApprovalChoice>;
  showQuestionnaire: (payload: AskUserPayload) => Promise<AskUserResponse>;
  saveSession: () => Promise<void>;
}): RunAgentTurnFn {
  const {
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
  } = deps;

  const runAgentTurn = async (input: string, spinnerPrefix?: string): Promise<void> => {
    logDebug(`[trace] runAgentTurn enter: mode=${refs.planExecutingRef.current ? 'agent(plan-exec)' : getMode()}, input="${input.slice(0, 60)}…"`);
    const turnStartedAt = Date.now();
    refs.isRunningRef.current = true;
    const abortController = new AbortController();
    refs.abortRef.current = abortController;
    const mode: Mode = refs.planExecutingRef.current ? 'agent' : getMode();

    setState({ agentState: 'running' });
    streamStore.setSpinner(true, spinnerPrefix ? `${spinnerPrefix}…` : 'Thinking…');
    // Finish the live phases cleanly: the accumulated thinking/response
    // text is committed to the log (once) and the panels stop rendering.
    const finishStreaming = (): void => {
      streamStore.commitThinking();
      streamStore.commitResponse();
    };

    try {
      // onStep — stream tool calls / results to the log immediately
      const onStep = (step: AgentStep): void => {
        if (step.toolCall) {
          // Tool execution begins — the streaming phases are over:
          // commit them so the log order stays thinking → text → tool.
          logDebug('[trace] runAgentTurn onStep: toolCall detected — committing live stream');
          finishStreaming();
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

          streamStore.setSpinner(true, spinnerPrefix ? `${spinnerPrefix}…` : 'Working…');
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
          logDebug('[trace] onApproval: user chose abort — calling abortController.abort()');
          abortController.abort();
        }
        // 'cancel' or 'abort' → deny
        return false;
      };

      // onText — stream assistant text into the live response panel.
      // If streaming isn't available (no callback wired, or the stream
      // fell back to buffered), the final response below still lands as
      // a normal entry.
      let streamedAnything = false;
      const onText = (delta: string): void => {
        // First text delta — the thinking phase is over: commit it as a
        // collapsed reasoning entry so it stays above the response.
        streamStore.commitThinking();
        streamedAnything = true;
        streamStore.appendResponse(delta);
      };

      // onReasoning — stream the model's thinking into the live thinking
      // panel, separate from the assistant text. Concatenation happens in
      // the store; only that panel re-renders per delta.
      const onReasoning = (delta: string): void => {
        streamStore.appendThinking(delta);
      };

      logDebug('[trace] runAgentTurn: calling agent.run()');
      const response = await agent.run(
        input,
        onStep,
        mode,
        true, // continueSession
        abortController.signal,
        onApproval,
        onText,
        onReasoning,
        showQuestionnaire,
      );
      logDebug(`[trace] runAgentTurn: agent.run() resolved (content=${response.content?.length ?? 0} chars)`);

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

      // Commit the streamed response as a normal assistant entry (the
      // fallback blob above was skipped when the stream produced it).
      finishStreaming();
      streamStore.setSpinner(false, '');

      // ── Queue drain ──────────────────────────────────────────
      const nextMessage = refs.queueRef.current.dequeue();
      if (nextMessage) {
        // Update queue display
        setState({ messageQueue: refs.queueRef.current.toArray() });
        // Log the de-queued message (no longer "queued" tag)
        addLog({
          type: 'user',
          content: nextMessage,
        });
        // Recurse to run the next turn
        await runAgentTurn(nextMessage, spinnerPrefix);
      } else {
        refs.isRunningRef.current = false;
        setState({
          agentState: 'idle',
          spinnerText: '',
          messageQueue: [],
        });
        // Plan-mode turn just finished with a written plan — execute it
        // (port of the old REPL's "Execute this plan?" flow). In `auto`
        // permission mode the user already granted execution, so start
        // immediately without the confirm modal; otherwise ask first.
        if (mode === 'plan') {
          const tasks = parseIncompleteTasks(await readPlanTaskFile(sessionId));
          if (tasks.length > 0) {
            const autoMode = agent.getConfig().permissionMode === 'auto';
            const execute = autoMode
              ? true
              : await new Promise<boolean>((resolve) => {
                  const deferred = createDeferred<boolean>();
                  refs.planConfirmDeferredRef.current = deferred;
                  setState({ pendingPlanConfirm: { taskCount: tasks.length } });
                  deferred.promise.then(resolve).catch((e) => logDebug(`[trace] planConfirm deferred rejected: ${(e as Error)?.message}`));
                });
            setState({ pendingPlanConfirm: null });
            if (execute) {
              // Switch to agent mode, then kick off execution — same
              // sequence as the old REPL (executeActivePlan → mode=agent).
              setMode('agent');
              addLog({
                type: 'system',
                content: 'Switched to agent mode.',
              });
              refs.executePlanRef.current();
            }
          }
        }
        // Terminal bell: long turns often finish while the user has
        // tabbed away — BEL snaps the tab/title indicator. Fire only
        // after a meaningful run so quick replies don't chirp.
        if (Date.now() - turnStartedAt >= BELL_MIN_TURN_MS) {
          process.stdout.write('\x07');
        }
      }
    } catch (err: unknown) {
      logDebug(`[trace] runAgentTurn catch: name=${(err as Error)?.name ?? 'unknown'} message=${(err as Error)?.message ?? String(err)} aborted=${abortController.signal.aborted}`);
      finishStreaming();
      // User abort (Esc) is a normal end of turn, not a failure — the old
      // path logged it as [ERROR] with a stack, spamming the log.
      if ((err as Error)?.name === 'AbortError' || abortController.signal.aborted) {
        streamStore.setSpinner(false, '');
        addLog({ type: 'system', content: 'Turn aborted.' });
        refs.isRunningRef.current = false;
        setState({ agentState: 'idle', spinnerText: '', messageQueue: refs.queueRef.current.toArray() });
        return;
      }
      streamStore.setSpinner(false, '');
      const message = err instanceof Error ? err.message : String(err);
      logError(`agent turn failed: ${message}\n${err instanceof Error ? err.stack ?? '' : ''}`);
      addLog({
        type: 'error',
        content: message,
      });
      refs.isRunningRef.current = false;
      setState({
        agentState: 'idle',
        spinnerText: '',
        messageQueue: refs.queueRef.current.toArray(),
      });
    }
  };

  return runAgentTurn;
}
