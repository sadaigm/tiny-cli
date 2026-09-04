import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  forwardRef,
  useSyncExternalStore,
} from 'react';
import { Box, Text, useInput, useStdout } from '../compat.js';
import type { LogEntry } from '../state.js';
import MessageItem, { MAX_STANDARD_BODY_LINES } from './MessageItem.js';
import { summarizeToolCall, summarizeToolResult } from '../utils/toolSummary.js';
import { markdownToLines } from '../utils/markdown.js';
import { copyToClipboard, entryClipboardText } from '../utils/clipboard.js';
import { bindingFor, matchesBinding } from '../keybindings.js';
import { useStreamStore } from './StreamProvider.js';
import ThinkingPanel from './ThinkingPanel.js';
import ResponsePanel from './ResponsePanel.js';
import Spinner from './Spinner.js';
import { getTheme } from '../theme.js';

/**
 * Imperative handle exposed by {@link MessageLog} so the mouse bridge and
 * other parents can drive the viewport without going through React state.
 */
export interface MessageLogHandle {
  /** Scroll the focus by `delta` rows (negative = up / older). */
  wheel: (delta: number) => void;
  /** Move focus to the first entry (top). */
  focusTop: () => void;
  /** Move focus to the last entry (bottom) and re-arm auto-follow. */
  focusBottom: () => void;
  /** Move focus to a specific entry id. No-op if the id is unknown. */
  focusEntry: (id: string) => void;
}

/**
 * Props for the {@link MessageLog} component.
 */
export interface MessageLogProps {
  /** Ordered list of log entries (oldest first). */
  entries: LogEntry[];
  /** Maximum number of terminal lines the log pane may occupy. */
  maxHeight?: number;
  /**
   * Whether this pane is allowed to consume keyboard input. False when a
   * higher-priority consumer (approval modal, selector overlay, autocomplete)
   * is open. This realises the key-precedence ladder.
   */
  active?: boolean;
  /** Whether browse mode is currently on (controlled). */
  browseMode?: boolean;
  /** Toggle browse mode on/off (called on Ctrl+P / Esc). */
  onBrowseModeChange?: (on: boolean) => void;
  /**
   * Whether an agent turn is in progress. While running, reasoning entries
   * stream in full; when it flips to false they collapse to one line each.
   */
  agentRunning?: boolean;
  /** Number of queued messages, shown on the in-pane status strip. */
  queuedCount?: number;
  /**
   * Whether native wheel scrolling drives the pane focus (replaces the old
   * StdinMouseBridge; OpenTUI delivers mouse events natively).
   */
  mouseEnabled?: boolean;
}

/** Clamp a value into the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

// ─── Local view state ──────────────────────────────────────────────────

interface LogView {
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

type LogViewAction =
  | { type: 'FOCUS_DELTA'; delta: number; length: number; setOffset?: number }
  | { type: 'FOCUS_ABS'; index: number; length: number; rearm?: boolean }
  | { type: 'SCROLL_LINE'; offset: number }
  | { type: 'TOGGLE_EXPAND'; id: string }
  | { type: 'TOGGLE_FOLD'; id: string }
  | { type: 'FOLD_TURNS'; ids: string[] }
  | { type: 'RECONCILE'; length: number; rearm?: boolean }
  | { type: 'RUNNING_CHANGE'; running: boolean; entries?: LogEntry[] };

function createLogView(length: number): LogView {
  return { focusIndex: length > 0 ? length - 1 : 0, expanded: new Set(), autoFollow: true, lineOffset: 0, folded: new Set() };
}

function logViewReducer(state: LogView, action: LogViewAction): LogView {
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

// ─── Line estimation & viewport math ───────────────────────────────────

/** Indent applied to message bodies in MessageItem (must match the render). */
const BODY_INDENT = 3;

/**
 * Count the rendered lines of a text block: each explicit newline is its
 * own line, plus soft-wrap chunks for lines longer than `usable` columns
 * (matching `wrapIndent`'s hard character chunking).
 */
function wrappedLineCount(text: string, usable: number): number {
  return text
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / usable)), 0);
}

/**
 * Estimate the terminal lines a single entry occupies when rendered.
 *
 * Must stay in sync with how {@link MessageItem} actually renders, or the
 * viewport math will pack the wrong number of entries and the pane will
 * overflow/clip (visible as flicker/jump, or a pane that appears stuck
 * when an expanded entry dwarfs the viewport).
 *
 * - tool_call / tool_result: 1 line when collapsed (summary); when
 *   expanded, 1 header line + the wrapped detail block from the same
 *   summarizer the renderer uses (same cap, same text).
 * - user / assistant: 1 header line + the body laid out by
 *   `markdownToLines(entry.content, usable)` — the SAME pure function
 *   MessageItem renders through, so the estimator counts the exact MdLine
 *   rows the renderer draws (markdown layout, word wrap, list/code rows).
 *   Collapsed bodies cap at MAX_STANDARD_BODY_LINES, expanded do not.
 * - system / info / error: treated like a wrapped body line.
 */
function estimateLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning = false, lineCap?: number, inTurn = false): number {
  const usable = Math.max(1, columns - BODY_INDENT);
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    if (!expanded.has(entry.id)) return 1;
    const detail =
      entry.type === 'tool_call'
        ? summarizeToolCall(entry, columns).detail
        : summarizeToolResult(entry, columns).detail;
    let lines = 1 + (detail ? wrappedLineCount(detail, usable) : 0);
    if (lineCap !== undefined) lines = Math.min(lines, 1 + lineCap);
    return lines;
  }
  // Reasoning: 1 header + full body while streaming; 1 header + 1 body
  // line when collapsed after the turn (matching MessageItem's render).
  if (entry.type === 'reasoning') {
    const rawBodyLines = entry.content.length === 0 ? 0 : wrappedLineCount(entry.content, usable);
    let bodyLines = entry.live || expanded.has(entry.id) ? rawBodyLines : Math.min(rawBodyLines, 1);
    if (lineCap !== undefined) bodyLines = Math.min(bodyLines, lineCap);
    return Math.max(1, 1 + bodyLines);
  }
  // Count rendered lines: markdown layout for user/assistant (the same
  // `markdownToLines` array MessageItem renders), `wrapIndent` chunk count
  // for the plain entry types. Collapsed standard entries cap at
  // MAX_STANDARD_BODY_LINES (matching MessageItem's render).
  // User/assistant messages are exempt — they render in full (see MessageItem).
  const rawBodyLines =
    entry.type === 'user' || entry.type === 'assistant'
      ? markdownToLines(entry.content, usable).length
      : entry.content.length === 0
        ? 0
        : wrappedLineCount(entry.content, usable);
  let bodyLines =
    expanded.has(entry.id) || entry.type === 'user' || entry.type === 'assistant'
      ? rawBodyLines
      : Math.min(rawBodyLines, MAX_STANDARD_BODY_LINES);
  if (lineCap !== undefined) bodyLines = Math.min(bodyLines, lineCap);
  // user/assistant have a header row ("❯" / "● Agent"); others are body-only.
  // Assistant entries inside a turn group render body-only (the group header
  // is the turn's single header), so they contribute no header line.
  const headerLines = entry.type === 'user' || (entry.type === 'assistant' && !inTurn) ? 1 : 0;
  return Math.max(1, headerLines + bodyLines);
}

/**
 * The wrapped body-line count of an entry as currently rendered (expanded
 * state honoured). Used to decide when ↑/↓ should scroll inside the focused
 * entry instead of moving to its neighbours.
 */
function renderedBodyLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning: boolean): number {
  const usable = Math.max(1, columns - BODY_INDENT);
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    if (!expanded.has(entry.id)) return 0;
    const detail =
      entry.type === 'tool_call'
        ? summarizeToolCall(entry, columns).detail
        : summarizeToolResult(entry, columns).detail;
    return detail ? wrappedLineCount(detail, usable) : 0;
  }
  if (entry.type === 'reasoning') {
    if (entry.content.length === 0) return 0;
    const raw = wrappedLineCount(entry.content, usable);
    return entry.live || expanded.has(entry.id) ? raw : Math.min(raw, 1);
  }
  if (entry.content.length === 0) return 0;
  // User/assistant: the same markdownToLines array MessageItem renders.
  const raw =
    entry.type === 'user' || entry.type === 'assistant'
      ? markdownToLines(entry.content, usable).length
      : wrappedLineCount(entry.content, usable);
  // User/assistant messages render in full even when collapsed (see MessageItem).
  if (entry.type === 'user' || entry.type === 'assistant') return raw;
  return expanded.has(entry.id) ? raw : Math.min(raw, MAX_STANDARD_BODY_LINES);
}

/** Lines of an entry's body the pane can show (1 pane header, 1 entry header). */
const VISIBLE_BODY_BUDGET = (paneHeight: number): number => Math.max(1, paneHeight - 2);

// ─── Turn grouping (render-time; no state) ────────────────────────────

/**
 * A render group: a slice of `entries` rendered together.
 *
 * `turn` groups are agent turns — the run of non-user entries following a
 * user entry. They render with a header row (`● Agent · gist … meta`) and a
 * left rail (`Box borderStyle="left"`) around their members, matching the
 * chat-redesign grammar. User entries (and anything before the first user
 * message) render loose — the pre-redesign look.
 */
interface RenderGroup {
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
function groupEntries(entries: LogEntry[]): RenderGroup[] {
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


/** Header text for a turn group: gist from the first assistant body, tools count. */
function groupKey(entries: LogEntry[], g: RenderGroup): string {
  return entries[g.start]?.id ?? `g${g.start}`;
}

/** Header text for a turn group: gist from the first assistant body, tools count. */
function turnHeader(entries: LogEntry[], group: RenderGroup): { gist: string; tools: number } {
  let gist = '';
  let tools = 0;
  for (let i = group.start; i < group.end; i++) {
    const e = entries[i];
    if (e.type === 'tool_call') tools++;
    if (!gist && e.type === 'assistant' && e.content) gist = e.content.split('\n')[0].replace(/^#+\s*/, '').trim();
  }
  return { gist, tools };
}

/**
 * Visible height of a turn group's rail: the sum of the members' rendered
 * lines, applying the same focused-entry cap the renderer applies — so the
 * rail is exactly as tall as the body beside it.
 */
function railHeight(
  entries: LogEntry[],
  expanded: Set<string>,
  from: number,
  to: number,
  columns: number,
  paneHeight: number,
  agentRunning: boolean,
  focusId?: string,
): number {
  const budget = VISIBLE_BODY_BUDGET(paneHeight);
  let total = 0;
  for (let i = from; i < to; i++) {
    const entry = entries[i];
    let lines = estimateLines(entry, columns, expanded, agentRunning, undefined, true);
    if (entry.id === focusId && renderedBodyLines(entry, columns, expanded, agentRunning) > budget) {
      lines = Math.min(lines, 1 + budget);
    }
    total += lines;
  }
  return Math.max(1, total);
}

/** Result of computing the visible window for the current focus + size. */
interface Window {
  startIndex: number;
  endIndex: number; // exclusive
  linesAbove: number;
  linesBelow: number;
}

/**
 * Compute the slice of `entries` to render so that the focused row is visible.
 *
 * The window is anchored on `focusIndex`, growing downward then upward until
 * `paneHeight` lines are consumed (one reserved for the header). When
 * `autoFollow` is set the window is pinned to the tail.
 */
function computeWindow(
  entries: LogEntry[],
  focusIndex: number,
  paneHeight: number,
  columns: number,
  autoFollow: boolean,
  expanded: Set<string>,
  agentRunning: boolean,
  extraLines: number[] = [],
  turnMember: boolean[] = [],
  lineOverride: (number | null)[] = [],
): Window {
  const n = entries.length;
  if (n === 0 || paneHeight <= 1) {
    return { startIndex: 0, endIndex: 0, linesAbove: 0, linesBelow: 0 };
  }
  // Rendered cost of an entry: folded-group members are overridden outright
  // (gist line = 1 on the group start, 0 on the rest); everything else is its
  // own estimate plus any group-header row, with turn members' assistant
  // entries suppressing their own header (inTurn).
  const cost = (i: number, cap?: number): number =>
    lineOverride[i] != null
      ? (lineOverride[i] as number)
      : estimateLines(entries[i], columns, expanded, agentRunning, cap, turnMember[i] ?? false) + (extraLines[i] ?? 0);
  // When the focused entry is expanded taller than the pane, its body is
  // windowed to this many lines (see MessageItem's maxLines) — cap the
  // estimate to match so the viewport math stays honest.
  const focusBudget = VISIBLE_BODY_BUDGET(paneHeight);
  const capFor = (i: number): number | undefined => {
    if (i !== focusIndex) return undefined;
    return estimateLines(entries[i], columns, expanded, agentRunning, undefined, turnMember[i] ?? false) - 1 > focusBudget
      ? focusBudget
      : undefined;
  };
  // Auto-follow: always show the tail.
  if (autoFollow) {
    const budget = paneHeight - 1;
    let start = n;
    let used = 0;
    for (let i = n - 1; i >= 0; i--) {
      const c = cost(i, capFor(i));
      if (used + c > budget && start < n) break;
      used += c;
      start = i;
    }
    return { startIndex: start, endIndex: n, linesAbove: start, linesBelow: 0 };
  }

  // Focus-anchored: grow downward first, then upward, to keep focus in view.
  const budget = paneHeight - 1;
  let start = focusIndex;
  let end = focusIndex + 1;
  let used = cost(focusIndex, capFor(focusIndex));

  // Grow downward.
  while (end < n && used < budget) {
    const c = cost(end, capFor(end));
    if (used + c > budget) break;
    used += c;
    end++;
  }
  // Grow upward.
  while (start > 0 && used < budget) {
    const c = cost(start - 1, capFor(start - 1));
    if (used + c > budget) break;
    used += c;
    start--;
  }

  return {
    startIndex: start,
    endIndex: end,
    linesAbove: start,
    linesBelow: n - end,
  };
}

// ─── Home/End detection ────────────────────────────────────────────────
// OpenTUI reports these as canonical key names; the raw-sequence checks
// remain as a legacy-terminal fallback.

const isHome = (input: string, key?: { home?: boolean }): boolean =>
  Boolean(key?.home) ||
  input === '\x1B[H' || input === '\x1B[1~' || input === '\x1B[7~' || input === '\x1BOH';
const isEnd = (input: string, key?: { end?: boolean }): boolean =>
  Boolean(key?.end) ||
  input === '\x1B[F' || input === '\x1B[4~' || input === '\x1B[8~' || input === '\x1BOF';

/**
 * Renders a focusable, scrollable view of {@link LogEntry} objects with
 * collapsible items.
 *
 * The pane owns its own view state (focus index, expanded set, auto-follow)
 * via a local reducer — it does not touch the global app state. Keyboard
 * navigation is gated by the `active` prop so it yields to higher-priority
 * consumers (modals, selector overlay, autocomplete).
 *
 * @example
 * ```tsx
 * <MessageLog ref={paneRef} entries={state.log} active={paneKeysActive} maxHeight={20} />
 * ```
 */
const MessageLog = forwardRef<MessageLogHandle, MessageLogProps>(function MessageLog(
  { entries, maxHeight, active = false, browseMode = false, onBrowseModeChange, agentRunning = false, queuedCount = 0, mouseEnabled = true },
  ref,
): React.ReactElement {
  const { stdout } = useStdout();

  // Terminal dimensions (re-read every render so resize works).
  const terminalRows = stdout?.rows ?? 24;
  const terminalColumns = stdout?.columns ?? 80;
  // `maxHeight` is the interior height of the bordered parent Box. The
  // border itself is drawn by the parent, so no further subtraction here.
  // Reserve 1 row for the `↑ N above · ↓ M below` header and 1 for the
  // status strip rendered at the bottom of this component.
  const paneHeight = Math.max(4, (maxHeight ?? terminalRows) - 2);
  const paneColumns = Math.max(10, terminalColumns - 2);

  const [view, dispatch] = useReducer(logViewReducer, entries.length, createLogView);

  // Transient feedback for the browse-mode `y` yank: shown on the pane
  // header line for a moment, cleared on the next key or after a timeout.
  const [yankStatus, setYankStatus] = useState('');
  useEffect(() => {
    if (!yankStatus) return;
    const t = setTimeout(() => setYankStatus(''), 2000);
    return () => clearTimeout(t);
  }, [yankStatus]);

  // Reconcile focus when the entry list grows / shrinks. When the newly
  // appended entries contain a user message (sent or drained from the
  // queue), re-arm auto-follow: sending a message is intent to watch the
  // conversation again, even if the user had scrolled up to read history.
  const prevLengthRef = useRef(entries.length);
  useEffect(() => {
    if (entries.length !== prevLengthRef.current) {
      const grew = entries.length > prevLengthRef.current;
      const rearm = grew && entries.slice(prevLengthRef.current).some((e) => e.type === 'user');
      dispatch({ type: 'RECONCILE', length: entries.length, rearm });
      // Submitting a message ages the conversation: every turn group except
      // the newest collapses to its one-line gist (chat-redesign behavior).
      if (rearm) {
        const turnGroups = groupEntries(entries).filter((g) => g.turn);
        const keepNewest = turnGroups[turnGroups.length - 1];
        dispatch({
          type: 'FOLD_TURNS',
          ids: turnGroups.filter((g) => g !== keepNewest).map((g) => groupKey(entries, g)),
        });
      }
      prevLengthRef.current = entries.length;
    }
  }, [entries.length, entries]);

  // Collapse reasoning sections when a turn finishes (running → false).
  const prevRunningRef = useRef(agentRunning);
  useEffect(() => {
    if (prevRunningRef.current && !agentRunning) {
      dispatch({ type: 'RUNNING_CHANGE', running: false, entries });
    }
    prevRunningRef.current = agentRunning;
  }, [agentRunning, entries]);

  // ── Browse mode ──────────────────────────────────────────────────────
  // The conversation pane never competes with the InputBox for printable
  // keys or the arrows/Tab that text editing uses. Instead the user enters
  // "browse mode" with Ctrl+P; only then do arrows/Tab/Home/End/PgUp/PgDn
  // drive the pane. Esc or Ctrl+P again returns to typing. This keeps `/`,
  // `@`, the letter `e`, and arrow-key cursor movement working in the input.
  // While browse mode is on, the parent hides the InputBox so there is no
  // key conflict at all.
  const setBrowse = useCallback(
    (on: boolean) => {
      onBrowseModeChange?.(on);
    },
    [onBrowseModeChange],
  );

  // Mirror the values onPaneKey branches on into refs. useInput keeps calling
  // the handler instance that was subscribed, so closures over render state
  // go stale (Ctrl+P flipped browseMode in the parent, but the pane handler
  // still saw false → arrows/Tab did nothing). Refs are stable boxes: even a
  // stale handler reads the live value through .current.
  const browseModeRef = useRef(browseMode);
  browseModeRef.current = browseMode;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const focusIndexRef = useRef(view.focusIndex);
  focusIndexRef.current = view.focusIndex;
  const paneHeightRef = useRef(paneHeight);
  paneHeightRef.current = paneHeight;
  const paneColumnsRef = useRef(paneColumns);
  paneColumnsRef.current = paneColumns;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Single always-on listener (when the pane is the active context).
  // Using ONE useInput — rather than two toggling ones — keeps Ink's raw
  // mode enabled exactly once and avoids raw-mode churn that can drop the
  // stdin readable listener and kill all input.
  const onPaneKey = useCallback(
    (input: string, key: { ctrl?: boolean; escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean; tab?: boolean; home?: boolean; end?: boolean }) => {
      const n = entriesRef.current.length;

      // The browse-mode hotkey (Ctrl+P by default, remappable via keys.json)
      // toggles from either state.
      if (matchesBinding(input, key, bindingFor('browse'))) {
        setBrowse(!browseModeRef.current);
        return;
      }
      // Inside browse mode: arrows/Tab/Home/End/PgUp/PgDn drive the pane;
      // Esc or Enter exits browse mode back to typing.
      if (browseModeRef.current) {
        if (key.escape || key.return) {
          setBrowse(false);
          return;
        }
        if (n === 0) return;
        if (key.upArrow || key.downArrow) {
          const dir = key.upArrow ? -1 : 1;
          const focused = entriesRef.current[viewRef.current.focusIndex];
          const lines = focused
            ? renderedBodyLines(focused, paneColumnsRef.current, viewRef.current.expanded, agentRunning)
            : 0;
          const visible = VISIBLE_BODY_BUDGET(paneHeightRef.current);
          if (lines > visible) {
            // Tall expanded entry: ↑/↓ scroll inside it first; once the
            // edge is reached, movement continues to the neighbour entry.
            const offset = viewRef.current.lineOffset;
            if (dir > 0 && offset < lines - visible) {
              dispatch({ type: 'SCROLL_LINE', offset: offset + 1 });
              return;
            }
            if (dir < 0 && offset > 0) {
              dispatch({ type: 'SCROLL_LINE', offset: offset - 1 });
              return;
            }
          }
          // Moving up into a tall entry lands at its bottom; moving down
          // into one lands at its top.
          const entering = viewRef.current.focusIndex + dir;
          const target = entriesRef.current[entering];
          let setOffset: number | undefined;
          if (target) {
            const targetLines = renderedBodyLines(
              target, paneColumnsRef.current, viewRef.current.expanded, agentRunning);
            if (dir < 0 && targetLines > VISIBLE_BODY_BUDGET(paneHeightRef.current)) {
              setOffset = targetLines - VISIBLE_BODY_BUDGET(paneHeightRef.current);
            }
          }
          dispatch({ type: 'FOCUS_DELTA', delta: dir, length: n, setOffset });
          return;
        }
        if (key.pageUp) dispatch({ type: 'FOCUS_DELTA', delta: -(paneHeightRef.current - 1), length: n });
        else if (key.pageDown) dispatch({ type: 'FOCUS_DELTA', delta: paneHeightRef.current - 1, length: n });
        else if (key.tab) {
          // Tab on a turn member folds/unfolds its whole turn; on a loose
          // entry it keeps the per-entry expand behavior.
          const focused = entriesRef.current[focusIndexRef.current];
          if (focused) {
            const fg = groupEntries(entriesRef.current).find(
              (g) => g.turn && focusIndexRef.current >= g.start && focusIndexRef.current < g.end,
            );
            if (fg) dispatch({ type: 'TOGGLE_FOLD', id: groupKey(entriesRef.current, fg) });
            else dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
          }
        } else if (matchesBinding(input, key, bindingFor('yank'))) {
          // Yank: OSC 52 copy of the focused entry's raw content (tool
          // args/result, or message text) to the local clipboard.
          const focused = entriesRef.current[focusIndexRef.current];
          if (focused) {
            const text = entryClipboardText(focused);
            const ok = copyToClipboard(text);
            setYankStatus(
              ok ? `📋 copied ${text.length} chars` : '⚠ copy needs a TTY (stdout redirected)',
            );
          }
        } else if (isHome(input, key)) dispatch({ type: 'FOCUS_ABS', index: 0, length: n });
        else if (isEnd(input, key)) dispatch({ type: 'FOCUS_ABS', index: n - 1, length: n, rearm: true });
      }
      // Outside browse mode this hook claims nothing — printable chars,
      // arrows, and Tab all pass through to the InputBox unchanged.
    },
    // Intentionally minimal: all branched-on values are read through refs
    // (see above), so re-creating the callback on every change is pointless —
    // useInput wouldn't pick up the new instance anyway. agentRunning is
    // read directly but only flips rarely; a stale value for one render is
    // harmless (it only affects scroll-eligibility of reasoning entries).
    [setBrowse, agentRunning],
  );
  useInput(onPaneKey, { isActive: active });

  // Imperative handle for mouse wheel + jump shortcuts.
  const dispatchWheel = useCallback(
    (delta: number) => dispatch({ type: 'FOCUS_DELTA', delta, length: entries.length }),
    [entries.length],
  );
  useImperativeHandle(
    ref,
    (): MessageLogHandle => ({
      wheel: dispatchWheel,
      focusTop: () => dispatch({ type: 'FOCUS_ABS', index: 0, length: entries.length }),
      focusBottom: () =>
        dispatch({ type: 'FOCUS_ABS', index: entries.length - 1, length: entries.length, rearm: true }),
      focusEntry: (id: string) => {
        const index = entries.findIndex((e) => e.id === id);
        if (index !== -1) dispatch({ type: 'FOCUS_ABS', index, length: entries.length });
      },
    }),
    [dispatchWheel, entries],
  );

  // Turn grouping — shared by the estimator and the renderer (see groupEntries).
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const turnMember = useMemo(() => {
    const member = new Array<boolean>(entries.length).fill(false);
    for (const g of groups) if (g.turn) for (let i = g.start; i < g.end; i++) member[i] = true;
    return member;
  }, [entries, groups]);

  // Layout facts derived once, shared by the estimator and the renderer:
  // - extra: +1 header row on each unfolded turn group start, +1 spacing row
  //   before every group except the very first entry.
  // - override: folded turn groups collapse to a single gist line
  //   (spacing + gist on the group start, 0 on the hidden members).
  const { extra, override } = useMemo(() => {
    const extra = new Array<number>(entries.length).fill(0);
    const override = new Array<number | null>(entries.length).fill(null);
    for (const g of groups) {
      const spacing = g.start > 0 ? 1 : 0;
      if (!g.turn) {
        extra[g.start] += spacing;
        continue;
      }
      if (view.folded.has(groupKey(entries, g))) {
        for (let i = g.start; i < g.end; i++) override[i] = 0;
        override[g.start] = spacing + 1; // blank row + gist line
      } else {
        extra[g.start] += spacing + 1; // blank row + `● Agent` header
      }
    }
    return { extra, override };
  }, [entries, groups, view.folded]);

  // Compute the visible window — memoised on relevant inputs.
  const win = useMemo(
    () => computeWindow(entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded, agentRunning, extra, turnMember, override),
    [entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded, agentRunning, extra, turnMember, override],
  );

  const visibleEntries = entries.slice(win.startIndex, win.endIndex);

  const positionHint =
    win.linesAbove + win.linesBelow > 0
      ? `↑ ${win.linesAbove} above · ↓ ${win.linesBelow} below${view.autoFollow ? ' · following' : ''}`
      : '';
  const headerText = browseMode
    ? `BROWSE — ↑↓/PgUp/PgDn scroll · Tab expand · y copy · Home/End · Esc to type${positionHint ? '  ·  ' + positionHint : ''}${yankStatus ? '  ·  ' + yankStatus : ''}`
    : `${positionHint ? positionHint + '  ·  ' : ''}Ctrl+P to browse`;

  // Chunk the visible window into render groups. Groups clipped by the
  // window still render correctly: their header/rail covers only the visible
  // members (the estimator charged the header when the group's first member
  // entered the window).
  const renderItem = (entry: LogEntry, index: number, inTurn = false): React.ReactElement => {
    const isFocused = entry.id === entries[view.focusIndex]?.id;
    const budget = VISIBLE_BODY_BUDGET(paneHeight);
    const scrollable =
      isFocused &&
      renderedBodyLines(entry, paneColumns, view.expanded, agentRunning) > budget;
    return (
      <MessageItem
        key={entry.id}
        entry={entry}
        focused={isFocused}
        expanded={view.expanded.has(entry.id)}
        agentRunning={agentRunning}
        columns={paneColumns}
        lineOffset={scrollable ? view.lineOffset : 0}
        maxLines={scrollable ? budget : undefined}
        inTurn={inTurn}
      />
    );
  };

  const theme = getTheme();
  const renderChunks = (): React.ReactElement[] => {
    const out: React.ReactElement[] = [];
    for (const g of groups) {
      if (g.end <= win.startIndex || g.start >= win.endIndex) continue;
      const from = Math.max(g.start, win.startIndex);
      const to = Math.min(g.end, win.endIndex);
      const blank = g.start > 0 && from === g.start ? <Text key={`sp-${g.start}`}>{' '}</Text> : null;
      if (blank) out.push(blank);
      if (!g.turn) {
        for (let i = from; i < to; i++) out.push(renderItem(entries[i], i));
        continue;
      }
      const live = agentRunning && g.end === entries.length;
      const { gist, tools } = turnHeader(entries, g);
      const meta = live ? 'streaming…' : `${tools} tool${tools === 1 ? '' : 's'}`;
      // Folded turn: one dim gist line (⌄ hints it can unfold).
      if (view.folded.has(groupKey(entries, g))) {
        out.push(
          <Box key={`fold-${g.start}`} justifyContent="space-between">
            <Text color={theme.toolResult}>
              {'● '}
              {gist ? gist.slice(0, Math.max(4, paneColumns - 24)) : 'Agent turn'}
            </Text>
            <Text dimColor>{meta}  ⌄</Text>
          </Box>,
        );
        continue;
      }
      // Agent turn: header row + left rail around its (visible) members.
      // The header renders only when the group's first member is inside the
      // window — exactly when the estimator charged its +1 line, so the
      // viewport math and the render stay in sync when the window clips a
      // group at the top.
      const railColor = live ? theme.accent : theme.border;
      out.push(
        <Box key={`turn-${g.start}`} flexDirection="column">
          {from === g.start ? (
            <Box justifyContent="space-between">
              <Text color={live ? theme.accent : theme.assistant}>
                {'● Agent'}
                {gist ? <Text color={theme.system}> · {gist.slice(0, Math.max(4, paneColumns - 24))}</Text> : null}
              </Text>
              <Text dimColor>{meta}  ⌃</Text>
            </Box>
          ) : null}
          {/* Ink has no single-side border: the rail is a 1-char column of │
              sized to the group's visible height (same estimator the window
              uses, same focus cap — keeps the rail exactly as tall as the body). */}
          <Box flexDirection="row">
            <Box width={1}>
              <Text color={railColor}>
                {Array.from(
                  { length: railHeight(entries, view.expanded, from, to, paneColumns, paneHeight, agentRunning, entries[view.focusIndex]?.id) },
                  () => '│',
                ).join('\n')}
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {entries.slice(from, to).map((entry, i) => renderItem(entry, from + i, true))}
            </Box>
          </Box>
        </Box>,
      );
    }
    return out;
  };

  return (
    // Fixed height + overflow hidden: the pane is a stable viewport that
    // never grows with its content. No flexGrow — the parent gives it an
    // Fixed height + overflow hidden: the pane is a stable viewport that
    // never grows with its content. No flexGrow — the parent gives it an
    // exact row budget. computeWindow limits visibleEntries to fit.
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        height={paneHeight}
        overflowY="hidden"
        onMouseScroll={
          mouseEnabled
            ? (event: { scroll: { direction: string } }) => {
                // Native wheel (replaces StdinMouseBridge): up = older (-1),
                // down = newer (+1), one focus step per event like the bridge.
                const delta = event.scroll.direction === 'up' ? -1 : 1;
                dispatchWheel(delta);
              }
            : undefined
        }
      >
        <Text dimColor> {headerText}</Text>
        {renderChunks()}
        {visibleEntries.length === 0 ? <Text dimColor> No messages yet — type below to begin.</Text> : null}
        {/* Live streaming phases — subscribed to the StreamStore, so token
            deltas re-render only these panels, never the whole App. */}
        {agentRunning ? <ThinkingPanel columns={paneColumns} /> : null}
        {agentRunning ? <ResponsePanel columns={paneColumns} /> : null}
      </Box>
      {/* Reserved 1-line status strip — constant height, no reflow. */}
      <SpinnerStrip agentRunning={agentRunning} queuedCount={queuedCount} />
    </Box>
  );
});

/**
 * One-line status strip at the bottom of the log pane. The spinner text
 * comes from the StreamStore (spinner-section subscription), so mid-turn
 * text changes don't re-render anything above this line.
 */
function SpinnerStrip({ agentRunning, queuedCount }: {
  agentRunning: boolean;
  queuedCount: number;
}): React.ReactElement {
  const store = useStreamStore();
  const spinner = useSyncExternalStore(store.subscribeSpinner, store.getSpinner);
  const theme = getTheme();

  const spinnerLine = agentRunning && spinner.active ? spinner.text : '';
  const line =
    spinnerLine || (queuedCount > 0
      ? `📬 ${queuedCount} queued message${queuedCount !== 1 ? 's' : ''}`
      : '');

  return (
    <Box height={1}>
      {line ? (
        agentRunning && spinnerLine ? (
          <Spinner text={line} />
        ) : (
          <Text dimColor color={theme.warning}> {line}</Text>
        )
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

// Memoize so typing in the InputBox (a sibling) doesn't re-render the
// conversation pane — Ink re-renders the whole tree on every commit, and
// without this the pane redraws (flicker) on every keystroke. Props are
// stable across plain typing (entries, booleans, useCallback setters).
const MemoizedMessageLog = React.memo(MessageLog);

export default MemoizedMessageLog;
