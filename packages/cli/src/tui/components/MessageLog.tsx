import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  forwardRef,
} from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { LogEntry } from '../state.js';
import MessageItem, { MAX_STANDARD_BODY_LINES } from './MessageItem.js';
import { summarizeToolCall, summarizeToolResult } from '../utils/toolSummary.js';
import { copyToClipboard, entryClipboardText } from '../utils/clipboard.js';
import { bindingFor, matchesBinding } from '../keybindings.js';

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
}

type LogViewAction =
  | { type: 'FOCUS_DELTA'; delta: number; length: number }
  | { type: 'FOCUS_ABS'; index: number; length: number; rearm?: boolean }
  | { type: 'TOGGLE_EXPAND'; id: string }
  | { type: 'RECONCILE'; length: number };

function createLogView(length: number): LogView {
  return { focusIndex: length > 0 ? length - 1 : 0, expanded: new Set(), autoFollow: true };
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
      return { ...state, focusIndex: next, autoFollow };
    }
    case 'FOCUS_ABS': {
      if (action.length === 0) return state;
      const max = action.length - 1;
      const next = clamp(action.index, 0, max);
      return { ...state, focusIndex: next, autoFollow: action.rearm ? true : next >= max };
    }
    case 'TOGGLE_EXPAND': {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.id)) expanded.delete(action.id);
      else expanded.add(action.id);
      return { ...state, expanded };
    }
    case 'RECONCILE': {
      // New entries arrived (or log cleared). Clamp focus; auto-follow pins to tail.
      if (action.length === 0) return createLogView(0);
      const max = action.length - 1;
      const focusIndex = state.autoFollow ? max : clamp(state.focusIndex, 0, max);
      return { ...state, focusIndex };
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
 * - user / assistant: 1 header line + body lines wrapped at
 *   `columns - BODY_INDENT` (matching `wrapIndent`'s indent); collapsed
 *   bodies cap at MAX_STANDARD_BODY_LINES, expanded bodies do not.
 * - system / info / error: treated like a wrapped body line.
 */
function estimateLines(entry: LogEntry, columns: number, expanded: Set<string>): number {
  const usable = Math.max(1, columns - BODY_INDENT);
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    if (!expanded.has(entry.id)) return 1;
    const detail =
      entry.type === 'tool_call'
        ? summarizeToolCall(entry, columns).detail
        : summarizeToolResult(entry, columns).detail;
    return 1 + (detail ? wrappedLineCount(detail, usable) : 0);
  }
  // Count rendered lines: each explicit newline is its own line, plus
  // soft-wrap for lines longer than the usable width. Collapsed standard
  // entries cap at MAX_STANDARD_BODY_LINES (matching MessageItem's render).
  const rawBodyLines = entry.content.length === 0 ? 0 : wrappedLineCount(entry.content, usable);
  const bodyLines = expanded.has(entry.id) ? rawBodyLines : Math.min(rawBodyLines, MAX_STANDARD_BODY_LINES);
  // user/assistant have a header row ("❯ You:" / "🤖 Agent:"); others are body-only.
  const headerLines = entry.type === 'user' || entry.type === 'assistant' ? 1 : 0;
  return Math.max(1, headerLines + bodyLines);
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
): Window {
  const n = entries.length;
  if (n === 0 || paneHeight <= 1) {
    return { startIndex: 0, endIndex: 0, linesAbove: 0, linesBelow: 0 };
  }
  // Auto-follow: always show the tail.
  if (autoFollow) {
    const budget = paneHeight - 1;
    let start = n;
    let used = 0;
    for (let i = n - 1; i >= 0; i--) {
      const cost = estimateLines(entries[i], columns, expanded);
      if (used + cost > budget && start < n) break;
      used += cost;
      start = i;
    }
    return { startIndex: start, endIndex: n, linesAbove: start, linesBelow: 0 };
  }

  // Focus-anchored: grow downward first, then upward, to keep focus in view.
  const budget = paneHeight - 1;
  let start = focusIndex;
  let end = focusIndex + 1;
  let used = estimateLines(entries[focusIndex], columns, expanded);

  // Grow downward.
  while (end < n && used < budget) {
    const cost = estimateLines(entries[end], columns, expanded);
    if (used + cost > budget) break;
    used += cost;
    end++;
  }
  // Grow upward.
  while (start > 0 && used < budget) {
    const cost = estimateLines(entries[start - 1], columns, expanded);
    if (used + cost > budget) break;
    used += cost;
    start--;
  }

  return {
    startIndex: start,
    endIndex: end,
    linesAbove: start,
    linesBelow: n - end,
  };
}

// ─── Home/End raw-sequence detection (Ink's Key omits these) ───────────

const isHome = (input: string): boolean =>
  input === '\x1B[H' || input === '\x1B[1~' || input === '\x1B[7~' || input === '\x1BOH';
const isEnd = (input: string): boolean =>
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
  { entries, maxHeight, active = false, browseMode = false, onBrowseModeChange },
  ref,
): React.ReactElement {
  const { stdout } = useStdout();

  // Terminal dimensions (re-read every render so resize works).
  const terminalRows = stdout?.rows ?? 24;
  const terminalColumns = stdout?.columns ?? 80;
  // `maxHeight` is the interior height of the bordered parent Box. The
  // border itself is drawn by the parent, so no further subtraction here.
  // Reserve 1 row for the `↑ N above · ↓ M below` header.
  const paneHeight = Math.max(4, (maxHeight ?? terminalRows) - 1);
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

  // Reconcile focus when the entry list grows / shrinks.
  const prevLengthRef = useRef(entries.length);
  useEffect(() => {
    if (entries.length !== prevLengthRef.current) {
      dispatch({ type: 'RECONCILE', length: entries.length });
      prevLengthRef.current = entries.length;
    }
  }, [entries.length]);

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

  // Single always-on listener (when the pane is the active context).
  // Using ONE useInput — rather than two toggling ones — keeps Ink's raw
  // mode enabled exactly once and avoids raw-mode churn that can drop the
  // stdin readable listener and kill all input.
  const onPaneKey = useCallback(
    (input: string, key: { ctrl?: boolean; escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean; tab?: boolean }) => {
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
        if (key.upArrow) dispatch({ type: 'FOCUS_DELTA', delta: -1, length: n });
        else if (key.downArrow) dispatch({ type: 'FOCUS_DELTA', delta: 1, length: n });
        else if (key.pageUp) dispatch({ type: 'FOCUS_DELTA', delta: -(paneHeightRef.current - 1), length: n });
        else if (key.pageDown) dispatch({ type: 'FOCUS_DELTA', delta: paneHeightRef.current - 1, length: n });
        else if (key.tab) {
          const focusedId = entriesRef.current[focusIndexRef.current]?.id;
          if (focusedId) dispatch({ type: 'TOGGLE_EXPAND', id: focusedId });
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
        } else if (isHome(input)) dispatch({ type: 'FOCUS_ABS', index: 0, length: n });
        else if (isEnd(input)) dispatch({ type: 'FOCUS_ABS', index: n - 1, length: n, rearm: true });
      }
      // Outside browse mode this hook claims nothing — printable chars,
      // arrows, and Tab all pass through to the InputBox unchanged.
    },
    // Intentionally minimal: all branched-on values are read through refs
    // (see above), so re-creating the callback on every change is pointless —
    // useInput wouldn't pick up the new instance anyway.
    [setBrowse],
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

  // Compute the visible window — memoised on relevant inputs.
  const win = useMemo(
    () => computeWindow(entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded),
    [entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded],
  );

  const visibleEntries = entries.slice(win.startIndex, win.endIndex);

  const positionHint =
    win.linesAbove + win.linesBelow > 0
      ? `↑ ${win.linesAbove} above · ↓ ${win.linesBelow} below${view.autoFollow ? ' · following' : ''}`
      : '';
  const headerText = browseMode
    ? `BROWSE — ↑↓/PgUp/PgDn scroll · Tab expand · y copy · Home/End · Esc to type${positionHint ? '  ·  ' + positionHint : ''}${yankStatus ? '  ·  ' + yankStatus : ''}`
    : `${positionHint ? positionHint + '  ·  ' : ''}Ctrl+P to browse`;

  return (
    // Fixed height + overflow hidden: the pane is a stable viewport that
    // never grows with its content. No flexGrow — the parent gives it an
    // exact row budget. computeWindow limits visibleEntries to fit.
    <Box flexDirection="column" height={paneHeight} overflowY="hidden">
      <Text dimColor> {headerText}</Text>
      {visibleEntries.map((entry) => (
        <MessageItem
          key={entry.id}
          entry={entry}
          focused={entry.id === entries[view.focusIndex]?.id}
          expanded={view.expanded.has(entry.id)}
          columns={paneColumns}
        />
      ))}
      {visibleEntries.length === 0 ? <Text dimColor> No messages yet — type below to begin.</Text> : null}
    </Box>
  );
});

// Memoize so typing in the InputBox (a sibling) doesn't re-render the
// conversation pane — Ink re-renders the whole tree on every commit, and
// without this the pane redraws (flicker) on every keystroke. Props are
// stable across plain typing (entries, booleans, useCallback setters).
const MemoizedMessageLog = React.memo(MessageLog);

export default MemoizedMessageLog;
