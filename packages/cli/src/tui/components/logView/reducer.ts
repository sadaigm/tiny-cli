/**
 * Local view state for the {@link MessageLog} pane: just the expand/fold
 * set (scrolling and focus are owned by the native `<scrollbox>` now).
 * Pure reducer — no React, no rendering concerns.
 */
import type { LogEntry } from '../../state.js';

export interface LogView {
  /** Entry ids that render their full detail block. */
  expanded: Set<string>;
}

export type LogViewAction =
  | { type: 'TOGGLE_EXPAND'; id: string }
  | { type: 'RUNNING_CHANGE'; running: boolean; entries?: LogEntry[] };

export function createLogView(): LogView {
  return { expanded: new Set() };
}

export function logViewReducer(state: LogView, action: LogViewAction): LogView {
  switch (action.type) {
    case 'TOGGLE_EXPAND': {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.id)) expanded.delete(action.id);
      else expanded.add(action.id);
      return { ...state, expanded };
    }
    case 'RUNNING_CHANGE': {
      // When the agent turn ends, reasoning entries that streamed live
      // collapse into one-line sections (expandable via Tab). Manual
      // expands for other entry types (assistant, tool_call, etc.) are preserved.
      if (action.running) return state;
      // Only remove reasoning entry IDs from the expanded set
      const expanded = new Set(state.expanded);
      if (action.entries) {
        action.entries.forEach((entry) => {
          if (entry.type === 'reasoning') {
            expanded.delete(entry.id);
          }
        });
      }
      return { ...state, expanded };
    }
    default:
      return state;
  }
}
