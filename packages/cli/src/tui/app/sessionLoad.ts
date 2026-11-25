import { useCallback } from 'react';
import type { Agent, Session, SessionMetadata } from '@tiny-cli/core';
import type { NewLogEntry } from '../hooks/useAgent.js';

/**
 * Re-applies the profile a session was last used with (if any). The session's
 * stored profileName wins over the global preference; a stale name is ignored.
 */
export async function applySessionProfile(
  agent: Agent,
  metadata: SessionMetadata,
  setConfig: (config: import('@tiny-cli/core').AgentConfig) => void
): Promise<void> {
  const name = metadata.profileName;
  if (!name || name === agent.getConfig().profileName) return;
  const { loadProfiles, profileToConfig, isProjectTrusted } = await import('../../config.js');
  const loaded = await loadProfiles();
  const profile = loaded?.profiles.find(p => p.name === name);
  if (!profile) return;
  const next = profileToConfig(profile, await isProjectTrusted());
  if (next.execTarget) {
    const { resolveHostRoot, detectContainerShell } = await import('@tiny-cli/core');
    if (next.execTarget.kind === 'container' && !next.execTarget.shell) {
      const shell = await detectContainerShell(next.execTarget.container);
      if (shell) next.execTarget = { ...next.execTarget, shell };
    }
    const pair = await resolveHostRoot(next.execTarget);
    if (pair) next.execTarget = { ...next.execTarget, root: pair.root, hostRoot: pair.hostRoot };
  }
  agent.updateConfig(next);
  setConfig(next);
}

/** Compact relative time like "2d ago" / "3h ago" / "just now". */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Add-log callback shape (same identity semantics as app.tsx's addLog). */
export interface AddLogFn {
  (entry: NewLogEntry): void;
}

/**
 * Replay persisted session messages into the transcript log. Compaction
 * summaries surface as a system entry. Each assistant tool_call is paired
 * with the tool-role result that follows it, so replayed history renders
 * the same rich tool cards (command + result) the live stream does.
 */
export function createReplaySessionMessages({
  addLog,
  addSystemLog,
}: {
  addLog: AddLogFn;
  addSystemLog: (content: string) => void;
}) {
  return useCallback(
    (messages: Session['messages']) => {
      // Assistant tool_calls indexed by id — consumed when the paired
      // tool-result message arrives.
      const callsById = new Map<string, { name: string; arguments: string }>();
      for (const m of messages) {
        const text = typeof m.content === 'string' ? m.content : '';
        if (m.role === 'system') {
          if (text.startsWith('[PREVIOUS CONTEXT SUMMARY]')) {
            const summary = text.slice('[PREVIOUS CONTEXT SUMMARY]'.length).trim();
            addSystemLog(`📋 Previous context (compacted): ${summary.slice(0, 200)}${summary.length > 200 ? '…' : ''}`);
          }
        } else if (m.role === 'assistant') {
          if (text.trim()) addLog({ type: 'assistant', content: text });
          for (const call of m.tool_calls ?? []) {
            callsById.set(call.id, { name: call.function.name, arguments: call.function.arguments });
          }
        } else if (m.role === 'tool') {
          const call = m.tool_call_id ? callsById.get(m.tool_call_id) : undefined;
          if (call && m.tool_call_id) callsById.delete(m.tool_call_id);
          addLog({
            type: 'tool_call',
            content: call?.name ?? 'tool',
            toolName: call?.name,
            toolArgs: call?.arguments,
          });
          addLog({
            type: 'tool_result',
            content: text,
            toolResult: text,
            toolName: call?.name,
          });
        } else if (text.trim()) {
          addLog({ type: m.role, content: text });
        }
      }
      // Calls whose result never landed (session persisted mid-execution or
      // aborted) still surface as compact markers so no step is lost.
      for (const call of callsById.values()) {
        addSystemLog(`🔧 ${call.name}`);
      }
    },
    [addLog, addSystemLog]
  );
}
