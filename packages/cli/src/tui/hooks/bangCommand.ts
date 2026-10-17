import type { Agent } from '@tiny-cli/core';
import { logError } from '@tiny-cli/core';
import type { AddLogFn } from './agentTypes.js';
import { parseBangInput, runShellCommand } from '../utils/shellExec.js';

/**
 * Bang-mode handler (`! command`), split out of useAgent.ts following the
 * createRunTurn/createPlanExecution factory idiom.
 *
 * Runs the command through the active exec target (no redirect/boundary
 * guards — the user typed it), shows the output as a `shell` entry, then
 * hands command + output to the agent as the next message: the agent
 * responds to what happened, and a non-zero exit comes with an explicit
 * ask to diagnose and fix it. Goes through submitMessage so
 * queue-while-busy semantics match every other user message.
 */
export function createBangCommand(deps: {
  agent: Agent;
  submitMessage: (text: string, displayText?: string) => void;
  addLog: AddLogFn;
}): (text: string) => Promise<void> {
  const { agent, submitMessage, addLog } = deps;
  return async (text: string): Promise<void> => {
    const cmd = parseBangInput(text);
    if (cmd === null) {
      addLog({ type: 'system', content: 'Usage: ! <command>' });
      return;
    }
    try {
      const { output, exitCode } = await runShellCommand(cmd, agent.getConfig().execTarget);
      const body = output || '(no output)';
      const exitLine = exitCode !== 0 ? `\n[exit ${exitCode}]` : '';
      // Framing matters: a bare "! cmd\n\noutput" reads as an instruction
      // to RUN the command — the model re-executes it via the bash tool.
      // State up front that it already ran and must not be re-run.
      const preamble =
        exitCode !== 0
          ? `I ran \`! ${cmd}\` in the shell myself — it already executed (do not run it again) and failed with exit code ${exitCode}. Output:`
          : `I ran \`! ${cmd}\` in the shell myself — it already executed (do not run it again). Output:`;
      const directive = exitCode !== 0 ? '\n\nDiagnose the error and fix it.' : '';
      // submitMessage logs the `! cmd` user bubble and either starts the
      // turn or queues it; the shell entry logs right after — still before
      // any streamed agent text can arrive, so the visual order is
      // bubble → output → agent response.
      submitMessage(`${preamble}\n\n${body}${exitLine}${directive}`, `! ${cmd}`);
      addLog({ type: 'shell', content: `${body}${exitLine}` });
    } catch (err) {
      // runShellCommand resolves on command failure; only spawn-level
      // infra errors land here.
      const message = (err as Error)?.message ?? String(err);
      logError(`runBangCommand: ${message}`);
      addLog({ type: 'error', content: `! ${cmd} failed: ${message}` });
    }
  };
}
