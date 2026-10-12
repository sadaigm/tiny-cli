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
    const { resolveHostRoot } = await import('@tiny-cli/core');
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
 * summaries surface as a system entry, tool-only assistant messages (no
 * text content) as compact tool markers — otherwise a compacted session
 * loads as a wall of empty agent bubbles.
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
      for (const m of messages) {
        const text = typeof m.content === 'string' ? m.content : '';
        if (m.role === 'system') {
          if (text.startsWith('[PREVIOUS CONTEXT SUMMARY]')) {
            const summary = text.slice('[PREVIOUS CONTEXT SUMMARY]'.length).trim();
            addSystemLog(`📋 Previous context (compacted): ${summary.slice(0, 200)}${summary.length > 200 ? '…' : ''}`);
          }
        } else if (m.role === 'assistant' && !text.trim() && m.tool_calls?.length) {
          for (const call of m.tool_calls) {
            addSystemLog(`🔧 ${call.function.name}`);
          }
        } else if ((m.role === 'user' || m.role === 'assistant') && text.trim()) {
          addLog({ type: m.role, content: text });
        }
      }
    },
    [addLog, addSystemLog]
  );
}
