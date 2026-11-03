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
import { logTrace } from '@tiny-cli/core';
import type { LogEntry } from '../state.js';
import MessageItem from './MessageItem.js';
import { logViewReducer, createLogView, type LogView } from './logView/reducer.js';
import { VISIBLE_BODY_BUDGET, renderedBodyLines, computeWindow } from './logView/estimator.js';
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
): React.ReactNode {
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
  const viewRef = useRef<LogView>(view);
  viewRef.current = view;

  // Single always-on listener (when the pane is the active context).
  // Using ONE useInput — rather than two toggling ones — keeps Ink's raw
  // mode enabled exactly once and avoids raw-mode churn that can drop the
  // stdin readable listener and kill all input.
  const onPaneKey = useCallback(
    (input: string, key: { ctrl?: boolean; shift?: boolean; escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean; tab?: boolean; home?: boolean; end?: boolean }) => {
      try {
      const n = entriesRef.current.length;

      // The browse-mode hotkey (Ctrl+P by default, remappable via keys.json)
      // toggles from either state.
      if (matchesBinding(input, key, bindingFor('browse'))) {
        setBrowse(!browseModeRef.current);
        return;
      }
      // Expand/collapse works in normal mode too — same effect as clicking
      // the card's header row. Targets the focused entry (the tail while
      // following).
      if (matchesBinding(input, key, bindingFor('expand'))) {
        const focused = entriesRef.current[viewRef.current.focusIndex];
        if (focused) dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
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
          // Tab toggles the focused card: expand/collapse (chat-cards design
          // — same effect as clicking the card's header row).
          const focused = entriesRef.current[focusIndexRef.current];
          if (focused) dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
        } else if (key.rightArrow) {
          // → Expand the focused card (no-op when already expanded).
          const focused = entriesRef.current[focusIndexRef.current];
          if (focused && !viewRef.current.expanded.has(focused.id)) {
            dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
          }
        } else if (key.leftArrow) {
          // ← Collapse the focused card (no-op when already collapsed).
          const focused = entriesRef.current[focusIndexRef.current];
          if (focused && viewRef.current.expanded.has(focused.id)) {
            dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
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
      } catch (err: unknown) {
        const e = err as Error;
        logTrace(`[trace] onPaneKey threw: ${e?.name}: ${e?.message}\ninput=${JSON.stringify(input)} key=${JSON.stringify(key)}\n${e?.stack ?? ''}`);
        throw err;
      }
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

  // Chat-cards layout: flat list, no turn grouping — computeWindow counts
  // each entry as its card (header + body) plus the 1-row gap between cards.
  // While streaming, rows are reserved for the live panels below the cards
  // (thinking ≤ 4 rows, response ≤ 1 + RESPONSE_CAP) so the pane never
  // overflows into the overlap garble.
  const responseCap = Math.max(3, Math.floor((paneHeight - 1) / 3));
  const reserve = agentRunning ? 4 + 1 + responseCap : 0;
  const win = useMemo(
    () => computeWindow(entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded, agentRunning, reserve),
    [entries, view.focusIndex, paneHeight, paneColumns, view.autoFollow, view.expanded, agentRunning, reserve],
  );

  const visibleEntries = entries.slice(win.startIndex, win.endIndex);

  const positionHint =
    win.linesAbove + win.linesBelow > 0
      ? `↑ ${win.linesAbove} above · ↓ ${win.linesBelow} below${view.autoFollow ? ' · following' : ''}`
      : '';
  const headerText = browseMode
    ? `BROWSE — ↑↓/PgUp/PgDn scroll · Tab expand · → expand · ← collapse · y copy · Home/End · Esc to type${positionHint ? '  ·  ' + positionHint : ''}${yankStatus ? '  ·  ' + yankStatus : ''}`
    : `${positionHint ? positionHint + '  ·  ' : ''}Ctrl+E expand · Ctrl+P to browse`;

  // Render one entry card at its current expand/focus state.
  const renderItem = (entry: LogEntry): React.ReactNode => {
    const isFocused = entry.id === entries[view.focusIndex]?.id;
    // Focus fill only in browse mode: during streaming, auto-follow moves
    // focus to each newest entry, which made new cards flash cardFocused
    // before settling into their family shade.
    const showFocused = isFocused && browseMode;
    const budget = VISIBLE_BODY_BUDGET(paneHeight);
    const scrollable =
      isFocused &&
      renderedBodyLines(entry, paneColumns, view.expanded, agentRunning) > budget;
    return (
      <MessageItem
        key={entry.id}
        entry={entry}
        focused={showFocused}
        expanded={view.expanded.has(entry.id)}
        agentRunning={agentRunning}
        columns={paneColumns}
        lineOffset={scrollable ? view.lineOffset : 0}
        maxLines={scrollable ? budget : undefined}
        onToggle={() => dispatch({ type: 'TOGGLE_EXPAND', id: entry.id })}
      />
    );
  };

  // Flat card list (chat-cards design): one card per entry, 1 blank row
  // between cards. The estimator charges the same gap (see computeWindow).
  const renderChunks = (): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (let i = win.startIndex; i < win.endIndex; i++) {
      if (i > 0) out.push(<Text key={`sp-${i}`}>{' '}</Text>);
      out.push(renderItem(entries[i]));
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
                logTrace(`[mouse] wheel: ${event.scroll.direction}`);
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
        {agentRunning ? <ResponsePanel columns={paneColumns} maxLines={responseCap} /> : null}
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
}): React.ReactNode {
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
