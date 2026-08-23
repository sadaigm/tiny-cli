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
import { Box, Text, useInput, useStdout } from 'ink';
import type { LogEntry } from '../state.js';
import MessageItem, { MAX_STANDARD_BODY_LINES } from './MessageItem.js';
import { summarizeToolCall, summarizeToolResult } from '../utils/toolSummary.js';
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
}

type LogViewAction =
  | { type: 'FOCUS_DELTA'; delta: number; length: number; setOffset?: number }
  | { type: 'FOCUS_ABS'; index: number; length: number; rearm?: boolean }
  | { type: 'SCROLL_LINE'; offset: number }
  | { type: 'TOGGLE_EXPAND'; id: string }
  | { type: 'RECONCILE'; length: number }
  | { type: 'RUNNING_CHANGE'; running: boolean; entries?: LogEntry[] };

function createLogView(length: number): LogView {
  return { focusIndex: length > 0 ? length - 1 : 0, expanded: new Set(), autoFollow: true, lineOffset: 0 };
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
    case 'RECONCILE': {
      // New entries arrived (or log cleared). Clamp focus; auto-follow pins to tail.
      if (action.length === 0) return createLogView(0);
      const max = action.length - 1;
      const focusIndex = state.autoFollow ? max : clamp(state.focusIndex, 0, max);
      return { ...state, focusIndex };
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
 * - user / assistant: 1 header line + body lines wrapped at
 *   `columns - BODY_INDENT` (matching `wrapIndent`'s indent); collapsed
 *   bodies cap at MAX_STANDARD_BODY_LINES, expanded bodies do not.
 * - system / info / error: treated like a wrapped body line.
 */
function estimateLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning = false, lineCap?: number): number {
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
  // Count rendered lines: each explicit newline is its own line, plus
  // soft-wrap for lines longer than the usable width. Collapsed standard
  // entries cap at MAX_STANDARD_BODY_LINES (matching MessageItem's render).
  const rawBodyLines = entry.content.length === 0 ? 0 : wrappedLineCount(entry.content, usable);
  let bodyLines = expanded.has(entry.id) ? rawBodyLines : Math.min(rawBodyLines, MAX_STANDARD_BODY_LINES);
  if (lineCap !== undefined) bodyLines = Math.min(bodyLines, lineCap);
  // user/assistant have a header row ("❯ You:" / "🤖 Agent:"); others are body-only.
  const headerLines = entry.type === 'user' || entry.type === 'assistant' ? 1 : 0;
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
  const raw = wrappedLineCount(entry.content, usable);
  return expanded.has(entry.id) ? raw : Math.min(raw, MAX_STANDARD_BODY_LINES);
}

/** Lines of an entry's body the pane can show (1 pane header, 1 entry header). */
const VISIBLE_BODY_BUDGET = (paneHeight: number): number => Math.max(1, paneHeight - 2);

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
): Window {
  const n = entries.length;
  if (n === 0 || paneHeight <= 1) {
    return { startIndex: 0, endIndex: 0, linesAbove: 0, linesBelow: 0 };
  }
  // When the focused entry is expanded taller than the pane, its body is
  // windowed to this many lines (see MessageItem's maxLines) — cap the
  // estimate to match so the viewport math stays honest.
  const focusBudget = VISIBLE_BODY_BUDGET(paneHeight);
  const capFor = (i: number): number | undefined => {
    if (i !== focusIndex) return undefined;
    return estimateLines(entries[i], columns, expanded, agentRunning) - 1 > focusBudget
      ? focusBudget
      : undefined;
  };
  // Auto-follow: always show the tail.
  if (autoFollow) {
    const budget = paneHeight - 1;
    let start = n;
    let used = 0;
    for (let i = n - 1; i >= 0; i--) {
      const cost = estimateLines(entries[i], columns, expanded, agentRunning, capFor(i));
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
  let used = estimateLines(entries[focusIndex], columns, expanded, agentRunning, capFor(focusIndex));

  // Grow downward.
  while (end < n && used < budget) {
    const cost = estimateLines(entries[end], columns, expanded, agentRunning, capFor(end));
    if (used + cost > budget) break;
    used += cost;
    end++;
  }
  // Grow upward.
  while (start > 0 && used < budget) {
    const cost = estimateLines(entries[start - 1], columns, expanded, agentRunning, capFor(start - 1));
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
  { entries, maxHeight, active = false, browseMode = false, onBrowseModeChange, agentRunning = false, queuedCount = 0 },
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

  // Reconcile focus when the entry list grows / shrinks.
  const prevLengthRef = useRef(entries.length);
  useEffect(() => {
    if (entries.length !== prevLengthRef.current) {
      dispatch({ type: 'RECONCILE', length: entries.length });
      prevLengthRef.current = entries.length;
    }
  }, [entries.length]);

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

  // Compute the visible window — memoised on relevant inputs.
  const win = useMemo(
    () => computeWindow(entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded, agentRunning),
    [entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded, agentRunning],
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
    // Fixed height + overflow hidden: the pane is a stable viewport that
    // never grows with its content. No flexGrow — the parent gives it an
    // exact row budget. computeWindow limits visibleEntries to fit.
    <Box flexDirection="column">
      <Box flexDirection="column" height={paneHeight} overflowY="hidden">
        <Text dimColor> {headerText}</Text>
        {visibleEntries.map((entry) => {
          const isFocused = entry.id === entries[view.focusIndex]?.id;
          // Only the focused entry participates in line-level scrolling: its
          // body is windowed to the pane budget at the current offset. Other
          // entries render whole (they were small enough to share the pane).
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
            />
          );
        })}
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
