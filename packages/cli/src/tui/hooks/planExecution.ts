import { logError, logDebug } from '@tiny-cli/core';
import { createDeferred } from '../utils/deferred.js';
import {
  readPlanTaskFile,
  writePlanTaskFile,
  readPlanFile,
  parseIncompleteTasks,
  isTaskMarkedComplete,
  markTaskCompleteInContent,
} from '../utils/planReader.js';
import type { AddLogFn, AgentRefs, RecoveryChoice, UseAgentSetState } from './agentTypes.js';
import type { RunAgentTurnFn } from './runTurn.js';

/**
 * Plan execution + its modals' resolve callbacks, split out of useAgent.ts
 * (mechanical move — bodies verbatim).
 */

export interface PlanExecutionApi {
  executePlan: () => void;
  resolveRecovery: (choice: RecoveryChoice) => void;
  resolvePlanConfirm: (execute: boolean) => void;
}

export function createPlanExecution(deps: {
  sessionId: string;
  setState: UseAgentSetState;
  addLog: AddLogFn;
  runAgentTurn: RunAgentTurnFn;
  refs: AgentRefs;
}): PlanExecutionApi {
  const { sessionId, setState, addLog, runAgentTurn, refs } = deps;

  /**
   * Execute the active plan: iterate over incomplete tasks, run each
   * through the agent, and handle recovery when tasks aren't marked done.
   *
   * Ported from `executeActivePlan()` in `repl.ts`, adapted for the
   * TUI.  Each task is run via `runAgentTurn` with a special
   * execution prompt, and tool approvals flow through the same
   * deferred-promise mechanism.  After each turn, the task file is
   * re-read to check whether the agent called `mark_task_complete`.
   * If not, a recovery modal is shown.
   *
   * The entire loop runs as a fire-and-forget background task — it is
   * never awaited by the render cycle. The InputBox stays live
   * so the user can type while tasks execute.
   */
  const executePlan = (): void => {
    // Fire-and-forget async IIFE
    void (async (): Promise<void> => {
      logDebug('[trace] executePlan: start');
      try {
        if (refs.planExecutingRef.current || refs.isRunningRef.current) {
          addLog({
            type: 'system',
            content: 'Cannot start plan execution — agent is already busy.',
          });
          return;
        }

        let taskFileContent = await readPlanTaskFile(sessionId);
        const tasks = parseIncompleteTasks(taskFileContent);
        if (tasks.length === 0) {
          addLog({
            type: 'system',
            content: 'No incomplete tasks found in the plan.',
          });
          return;
        }

        refs.planExecutingRef.current = true;
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
          // A previous turn may have batch-completed later tasks (execution
          // prompt allows one mark_task_complete per finished task) — skip
          // those without burning an agent turn on them.
          if (isTaskMarkedComplete(taskFileContent, task.text)) {
            addLog({
              type: 'system',
              content: `Task ${i + 1}/${tasks.length} already completed — skipping.`,
            });
            continue;
          }
          addLog({
            type: 'plan',
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
3. Only call 'mark_task_complete' if the code is actually written and tested.
4. If finishing this task also fully completes the next small task(s) in the plan, call 'mark_task_complete' for each of those too — do not leave trivial follow-up tasks for later turns.
5. Do NOT execute tests, builds, or dev servers for this task — WRITE tests alongside the code only. Test execution happens once, in the plan's final verification task (or manually by the user). Exception: if this IS the final verification task, run the full suite now and fix failures.`;

            // Run the agent turn (fire-and-forget but we await inside this IIFE)
            logDebug(`[trace] executePlan: task ${i + 1}/${tasks.length} — running turn`);
            await runAgentTurn(
              prompt,
              `Executing Task ${i + 1}/${tasks.length}`,
            );
            logDebug(`[trace] executePlan: task ${i + 1}/${tasks.length} — turn done, aborted=${refs.abortRef.current?.signal.aborted}`);

            // Check abort
            if (refs.abortRef.current?.signal.aborted) {
              abortExecution = true;
              break;
            }

            // Re-read the task file to check if task was marked complete
            taskFileContent = await readPlanTaskFile(sessionId);
            const isComplete = isTaskMarkedComplete(taskFileContent, task.text);

            if (isComplete) {
              addLog({
                type: 'system',
                content: `Task ${i + 1}/${tasks.length} completed.`,
              });
            } else {
              // Show recovery modal
              const choice = await new Promise<RecoveryChoice>((resolve) => {
                const deferred = createDeferred<RecoveryChoice>();
                refs.recoveryDeferredRef.current = deferred;
                setState({
                  pendingRecovery: {
                    taskIndex: i,
                    taskText: task.raw,
                    totalTasks: tasks.length,
                  },
                });
                deferred.promise.then(resolve).catch((e) => logDebug(`[trace] recovery deferred rejected: ${(e as Error)?.message}`));
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
                  taskFileContent = manualContent;
                  addLog({
                    type: 'plan',
                    content: `Task ${i + 1}/${tasks.length} marked as done manually.`,
                  });
                  break;
                }
                case 'skip':
                  addLog({
                    type: 'plan',
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

        refs.planExecutingRef.current = false;
        setState({ planExecuting: false });
        addLog({
          type: 'plan',
          content: abortExecution
            ? 'Plan execution aborted.'
            : 'Plan execution finished. All tasks processed.',
        });
      } catch (err: unknown) {
        logDebug(`[trace] executePlan catch: name=${(err as Error)?.name ?? 'unknown'} message=${(err as Error)?.message ?? String(err)}`);
        // The IIFE is fire-and-forget — an uncaught throw here would
        // surface as an unhandledRejection (e.g. AbortError on user abort).
        refs.planExecutingRef.current = false;
        setState({ planExecuting: false, agentState: 'idle', spinnerText: '' });
        const message = err instanceof Error ? err.message : String(err);
        if (!(err instanceof Error && (err.name === 'AbortError' || message === 'The operation was aborted.'))) {
          logError(`plan execution failed: ${message}`);
          addLog({ type: 'error', content: message });
        } else {
          addLog({ type: 'plan', content: 'Plan execution aborted.' });
        }
      }
    })();
  };

  /**
   * Resolve the pending recovery modal.
   *
   * Called by `<RecoveryModal>` when the user selects an option.
   * Settles the deferred promise, unblocking `executePlan`.
   */
  const resolveRecovery = (choice: RecoveryChoice): void => {
    const deferred = refs.recoveryDeferredRef.current;
    if (deferred) {
      refs.recoveryDeferredRef.current = null;
      deferred.resolve(choice);
    }
  };

  /**
   * Resolve the pending plan-execute confirm modal.
   *
   * Called by `<PlanConfirmModal>` when the user selects an option.
   * Settles the deferred promise, unblocking `runAgentTurn`.
   */
  const resolvePlanConfirm = (execute: boolean): void => {
    const deferred = refs.planConfirmDeferredRef.current;
    if (deferred) {
      refs.planConfirmDeferredRef.current = null;
      deferred.resolve(execute);
    }
  };

  return { executePlan, resolveRecovery, resolvePlanConfirm };
}
