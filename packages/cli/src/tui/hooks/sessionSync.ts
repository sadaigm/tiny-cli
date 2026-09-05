import type { Agent, SessionManager } from '@tiny-cli/core';
import { SessionManager as SessionManagerCtor } from '@tiny-cli/core';
import type { AddLogFn, UseAgentSetState } from './agentTypes.js';

/**
 * Session persistence + agent event wiring, split out of useAgent.ts
 * (mechanical move — bodies verbatim).

 * Both are factories: the facade creates them once (useMemo) and passes
 * the results to the other hook modules.
 */

/**
 * Persist the agent's conversation history and update context stats.
 */
export function createSaveSession(deps: {
  agent: Agent;
  sessionManager: SessionManager;
  sessionId: string;
  setState: UseAgentSetState;
}): () => Promise<void> {
  const { agent, sessionManager, sessionId, setState } = deps;
  return async (): Promise<void> => {
    try {
      const messages = agent.getHistory();
      // Create-on-first-save: if the file doesn't exist yet (startup no
      // longer pre-writes an empty one), persist instead of silently
      // dropping the whole conversation.
      const session =
        (await sessionManager.loadSession(sessionId)) ??
        SessionManagerCtor.createSession(sessionId);
      session.messages = messages;
      session.metadata.lastUpdatedAt = new Date().toISOString();
      await sessionManager.saveSession(session);
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
  };
}

/**
 * Wire the Agent instance's history/compaction/model-error callbacks.
 * Returns the unwire fn for the facade's effect cleanup.
 */
export function wireAgentEvents(
  agent: Agent,
  setState: UseAgentSetState,
  addLog: AddLogFn,
): () => void {
  // Recompute stats after every message appended to the agent's history,
  // and surface compactions as a system log line.
  agent.onHistoryChange = () => {
    try {
      setState({ contextStats: agent.getContextStats() });
    } catch {
      // ignore
    }
  };
  agent.onCompaction = (before, after) => {
    addLog({
      type: 'system',
      content: `Memory compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`,
    });
  };
  agent.onModelError = (err) => {
    addLog({
      type: 'error',
      content: `Model request failed: ${err.message} — continuing`,
    });
  };
  return () => {
    agent.onHistoryChange = undefined;
    agent.onCompaction = undefined;
    agent.onModelError = undefined;
  };
}
