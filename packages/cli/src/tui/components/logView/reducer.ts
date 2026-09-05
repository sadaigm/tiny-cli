/**
 * Local view state for the {@link MessageLog} pane: focus index, expanded /
 * folded sets, auto-follow, and per-entry line scroll. Pure reducer — no
 * React, no rendering concerns (see estimator.ts for the line math).
 */
import type { LogEntry } from '../../state.js';

/** Clamp a value into the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

export interface LogView {
  /** Index into `entries` of the focused (highlighted) row. */
  focusIndex: number;
  /** Entry ids that render their full detail block. */
  expanded: Set<string>;
  /** When true, focus pins to the tail and new appends auto-scroll. */
  autoFollow: boolean;
  /**
   * Line scroll within the focused entry, when it is expanded and taller
   * than the pane. 0 = top of the entry's body.
   */
  lineOffset: number;
  /**
   * Ids of turn groups (keyed by the group's first entry id) folded to
   * their one-line gist. Submitting a message folds every completed turn;
   * Tab on a folded turn unfolds it (chat-redesign aging behavior).
   */
  folded: Set<string>;
}

export type LogViewAction =
  | { type: 'FOCUS_DELTA'; delta: number; length: number; setOffset?: number }
  | { type: 'FOCUS_ABS'; index: number; length: number; rearm?: boolean }
  | { type: 'SCROLL_LINE'; offset: number }
  | { type: 'TOGGLE_EXPAND'; id: string }
  | { type: 'TOGGLE_FOLD'; id: string }
  | { type: 'FOLD_TURNS'; ids: string[] }
  | { type: 'RECONCILE'; length: number; rearm?: boolean }
  | { type: 'RUNNING_CHANGE'; running: boolean; entries?: LogEntry[] };

export function createLogView(length: number): LogView {
  return { focusIndex: length > 0 ? length - 1 : 0, expanded: new Set(), autoFollow: true, lineOffset: 0, folded: new Set() };
}

export function logViewReducer(state: LogView, action: LogViewAction): LogView {
  switch (action.type) {
    case 'FOCUS_DELTA': {
      if (action.length === 0) return state;
      const max = action.length - 1;
      // Moving down at the tail is a no-op (keeps autoFollow behaviour stable).
      const next = clamp(state.focusIndex + action.delta, 0, max);
      // Any upward movement disables auto-follow so the view stays put.
      const autoFollow = action.delta < 0 ? false : state.autoFollow && next >= max;
      // Entering a tall entry from below starts at its bottom (pager-style);
      // `setOffset` lets the key handler decide where a new entry opens.
      const lineOffset = action.setOffset ?? state.lineOffset;
      return { ...state, focusIndex: next, autoFollow, lineOffset };
    }
    case 'FOCUS_ABS': {
      if (action.length === 0) return state;
      const max = action.length - 1;
      const next = clamp(action.index, 0, max);
      return { ...state, focusIndex: next, autoFollow: action.rearm ? true : next >= max, lineOffset: 0 };
    }
    case 'SCROLL_LINE': {
      if (action.offset === state.lineOffset) return state;
      return { ...state, lineOffset: Math.max(0, action.offset), autoFollow: false };
    }
    case 'TOGGLE_EXPAND': {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.id)) expanded.delete(action.id);
      else expanded.add(action.id);
      return { ...state, expanded, lineOffset: 0 };
    }
    case 'TOGGLE_FOLD': {
      const folded = new Set(state.folded);
      if (folded.has(action.id)) folded.delete(action.id);
      else folded.add(action.id);
      return { ...state, folded };
    }
    case 'FOLD_TURNS': {
      // Fold unconditionally (ids already exclude live/newest groups) — a
      // turn the user manually unfolded stays folded on the next submit,
      // matching the chat-redesign rule "old turns age to one line".
      const folded = new Set(state.folded);
      for (const id of action.ids) folded.add(id);
      return { ...state, folded };
    }
    case 'RECONCILE': {
      // New entries arrived (or log cleared). Clamp focus; auto-follow pins to tail.
      if (action.length === 0) return createLogView(0);
      const max = action.length - 1;
      const focusIndex = state.autoFollow || (action.rearm ?? false) ? max : clamp(state.focusIndex, 0, max);
      return { ...state, focusIndex, autoFollow: state.autoFollow || (action.rearm ?? false) };
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
