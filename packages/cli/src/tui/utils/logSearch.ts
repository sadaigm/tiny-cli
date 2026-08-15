/**
 * Text search over the conversation log.
 *
 * Backs `/find <text>`: case-insensitive substring match over every
 * entry's searchable text — message content plus tool name and arguments
 * for tool calls, so `find "package.json"` hits both the assistant
 * message that mentioned it and the `write` tool call that touched it.
 */

import type { LogEntry } from '../state.js';

/** A single search hit. */
export interface LogSearchHit {
  /** Index into the searched entries (oldest first). */
  index: number;
  /** The matching entry's id (used to jump the pane's focus). */
  id: string;
  /** Entry type, for the result listing (user/assistant/tool_call/…). */
  type: LogEntry['type'];
  /** First matching line of the entry, capped for one-line display. */
  preview: string;
  /** 1-based rank from the newest hit (1 = most recent). */
  matchNumber: number;
  /** Total hits. */
  matchCount: number;
}

/** Longest preview line shown per hit in the result list. */
const PREVIEW_MAX = 120;

/**
 * All text of an entry worth searching: content, tool name, args, result.
 */
function searchableText(entry: LogEntry): string {
  const toolBits =
    entry.type === 'tool_call'
      ? ` ${entry.toolName ?? ''} ${entry.toolArgs ?? ''}`
      : entry.type === 'tool_result'
        ? ` ${entry.toolName ?? ''} ${entry.toolResult ?? ''}`
        : '';
  return `${entry.content}${toolBits}`;
}

/**
 * Find entries containing `query` (case-insensitive substring).
 *
 * Results are newest-first so the first hit is the most recent context —
 * what you usually want when hunting for something said earlier. An empty
 * or whitespace-only query matches nothing.
 */
export function findInLog(entries: readonly LogEntry[], query: string): LogSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: Omit<LogSearchHit, 'matchNumber' | 'matchCount'>[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!searchableText(entry).toLowerCase().includes(needle)) continue;
    const firstLine =
      entry.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? '';
    const label =
      entry.type === 'tool_call' || entry.type === 'tool_result'
        ? `${entry.toolName ?? 'tool'}`
        : firstLine;
    hits.push({
      index: i,
      id: entry.id,
      type: entry.type,
      preview: label.slice(0, PREVIEW_MAX),
    });
  }
  return hits.map((hit, i) => ({ ...hit, matchNumber: i + 1, matchCount: hits.length }));
}
