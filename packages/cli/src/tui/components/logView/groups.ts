/**
 * Turn grouping (render-time; no state): partition entries into render
 * groups shared by the viewport estimator (estimator.ts) and the renderer
 * (MessageLog.tsx), so both agree on the extra header line each turn group
 * contributes.
 */
import type { LogEntry } from '../../state.js';

/**
 * A render group: a slice of `entries` rendered together.
 *
 * `turn` groups are agent turns — the run of non-user entries following a
 * user entry. They render with a header row (`● Agent · gist … meta`) and a
 * left rail (`Box borderStyle="left"`) around their members, matching the
 * chat-redesign grammar. User entries (and anything before the first user
 * message) render loose — the pre-redesign look.
 */
export interface RenderGroup {
  /** Inclusive start index into `entries`. */
  start: number;
  /** Exclusive end index into `entries`. */
  end: number;
  /** Agent turn (rail + header) vs loose entry. */
  turn: boolean;
}

/**
 * Partition entries into render groups. Pure; memoised by the component and
 * shared by the viewport estimator and the renderer so both agree on the
 * extra header line each turn group contributes.
 */
export function groupEntries(entries: LogEntry[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let i = 0;
  while (i < entries.length) {
    if (entries[i].type === 'user') {
      groups.push({ start: i, end: i + 1, turn: false });
      i++;
      const start = i;
      while (i < entries.length && entries[i].type !== 'user') i++;
      if (i > start) groups.push({ start, end: i, turn: true });
    } else {
      // Entries before any user message (session hydration, banners).
      groups.push({ start: i, end: i + 1, turn: false });
      i++;
    }
  }
  return groups;
}

/** Stable identity for a turn group (its first entry's id). */
export function groupKey(entries: LogEntry[], g: RenderGroup): string {
  return entries[g.start]?.id ?? `g${g.start}`;
}

/** Header text for a turn group: gist from the first assistant body, tools count. */
export function turnHeader(entries: LogEntry[], group: RenderGroup): { gist: string; tools: number } {
  let gist = '';
  let tools = 0;
  for (let i = group.start; i < group.end; i++) {
    const e = entries[i];
    if (e.type === 'tool_call') tools++;
    if (!gist && e.type === 'assistant' && e.content) gist = e.content.split('\n')[0].replace(/^#+\s*/, '').trim();
  }
  return { gist, tools };
}
