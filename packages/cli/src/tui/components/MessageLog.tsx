import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  forwardRef,
  useSyncExternalStore,
} from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { Box, Text, useInput, useStdout } from '../compat.js';
import { logTrace } from '@tiny-cli/core';
import type { LogEntry } from '../state.js';
import MessageItem from './MessageItem.js';
import { logViewReducer, createLogView, type LogView } from './logView/reducer.js';
import { copyToClipboard, entryClipboardText } from '../utils/clipboard.js';
import { onSelectionCopy } from '../utils/selectionCopy.js';
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
  /** Scroll to the last entry (bottom) and re-arm sticky follow. */
  focusBottom: () => void;
  /** Scroll to a specific entry id. No-op if the id is unknown. */
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

/** True when the scrollbox's scrollTop sits at (or past) its bottom edge. */
function isAtBottom(sb: ScrollBoxRenderable): boolean {
  const viewportHeight = (sb as unknown as { viewport?: { height?: number } }).viewport?.height;
  if (viewportHeight === undefined) return true;
  return sb.scrollTop + viewportHeight >= sb.scrollHeight;
}

/** Rows hidden above / below the scrollbox viewport (for the header hint). */
function scrollPosition(sb: ScrollBoxRenderable): { above: number; below: number } {
  const viewportHeight = (sb as unknown as { viewport?: { height?: number } }).viewport?.height ?? 0;
  return {
    above: Math.max(0, Math.round(sb.scrollTop)),
    below: Math.max(0, Math.round(sb.scrollHeight - sb.scrollTop - viewportHeight)),
  };
}

/**
 * Renders a scrollable view of {@link LogEntry} objects with collapsible
 * items, backed by a native OpenTUI `<scrollbox>` (sticky bottom follow,
 * viewport culling, real Yoga-measured heights — no line estimation).
 *
 * The pane owns only the expand/fold set via a local reducer — it does not
 * touch the global app state. Keyboard navigation is gated by the `active`
 * prop so it yields to higher-priority consumers (modals, overlays).
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
  // Reserve 1 row for the header hints and 1 for the status strip.
  const paneHeight = Math.max(4, (maxHeight ?? terminalRows) - 2);
  const paneColumns = Math.max(10, terminalColumns - 2);

  const [view, dispatch] = useReducer(logViewReducer, undefined, createLogView);

  // Sticky bottom-follow: scrolling up disengages it, returning to the
  // bottom (wheel down / End) re-engages.
  const [stickyScroll, setStickyScroll] = useState(true);

  // Scroll-position hint (`↑ N above · ↓ M below`), refreshed from the
  // scrollbox after every scroll action and when the log content changes.
  // Null while pinned to the bottom (nothing hidden either way).
  const [scrollPos, setScrollPos] = useState<{ above: number; below: number } | null>(null);
  const refreshScrollPos = useCallback(() => {
    const sb = scrollboxRef.current;
    if (!sb) return;
    const pos = scrollPosition(sb);
    setScrollPos(pos.above > 0 || pos.below > 0 ? pos : null);
  }, []);

  // Native scrollbox instance — all scrolling goes through its methods.
  const scrollboxRef = useRef<ScrollBoxRenderable>(null);
  const scrollboxRefCb = useCallback((node: ScrollBoxRenderable | null) => {
    scrollboxRef.current = node;
  }, []);

  // Transient feedback for the browse-mode `y` yank and mouse-selection
  // auto-copy: shown as a colored segment on the pane header line for a
  // moment, cleared after a timeout. kind picks the theme color — success
  // green for a copy, warning for a failure.
  const [yankStatus, setYankStatus] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null);

  useEffect(() => {
    if (!yankStatus) return;
    const t = setTimeout(() => setYankStatus(null), 2000);
    return () => clearTimeout(t);
  }, [yankStatus]);

  // Auto-copy on mouse selection (wired in render.tsx): the renderer-side
  // listener copies the selected text and reports the counts here to show
  // through the same transient status line.
  useEffect(() =>
    onSelectionCopy(({ chars, words, copied }) =>
      setYankStatus(
        copied
          ? { text: `📋 selected ${chars} chars · ${words} words — copied`, kind: 'ok' }
          : { text: `⚠ selected ${chars} chars · ${words} words — copy failed`, kind: 'warn' },
      ),
    ),
  );

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
  const paneHeightRef = useRef(paneHeight);
  paneHeightRef.current = paneHeight;
  const viewRef = useRef<LogView>(view);
  viewRef.current = view;

  // Single always-on listener (when the pane is the active context).
  // Using ONE useInput — rather than two toggling ones — keeps Ink's raw
  // mode enabled exactly once and avoids raw-mode churn that can drop the
  // stdin readable listener and kill all input.
  const onPaneKey = useCallback(
    (input: string, key: { ctrl?: boolean; shift?: boolean; escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean; tab?: boolean; home?: boolean; end?: boolean }) => {
      try {
      // The browse-mode hotkey (Ctrl+P by default, remappable via keys.json)
      // toggles from either state.
      if (matchesBinding(input, key, bindingFor('browse'))) {
        setBrowse(!browseModeRef.current);
        return;
      }
      // Expand/collapse works in normal mode too — same effect as clicking
      // the card's header row. Targets the newest entry (the tail).
      if (matchesBinding(input, key, bindingFor('expand'))) {
        const focused = entriesRef.current.at(-1);
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
        const sb = scrollboxRef.current;
        if (key.upArrow) {
          sb?.scrollBy(-3);
          setStickyScroll(false);
        } else if (key.downArrow) {
          sb?.scrollBy(3);
          if (sb) setStickyScroll(isAtBottom(sb));
        } else if (key.pageUp) {
          sb?.scrollBy(-(paneHeightRef.current - 1));
          setStickyScroll(false);
        } else if (key.pageDown) {
          sb?.scrollBy(paneHeightRef.current - 1);
          if (sb) setStickyScroll(isAtBottom(sb));
        } else if (key.tab) {
          // Tab toggles the newest card: expand/collapse (chat-cards design
          // — same effect as clicking the card's header row).
          const focused = entriesRef.current.at(-1);
          if (focused) dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
        } else if (key.rightArrow) {
          // → Expand the newest card (no-op when already expanded).
          const focused = entriesRef.current.at(-1);
          if (focused && !viewRef.current.expanded.has(focused.id)) {
            dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
          }
        } else if (key.leftArrow) {
          // ← Collapse the newest card (no-op when already collapsed).
          const focused = entriesRef.current.at(-1);
          if (focused && viewRef.current.expanded.has(focused.id)) {
            dispatch({ type: 'TOGGLE_EXPAND', id: focused.id });
          }
        } else if (matchesBinding(input, key, bindingFor('yank'))) {
          // Yank: OSC 52 copy of the newest entry's raw content (tool
          // args/result, or message text) to the local clipboard.
          const focused = entriesRef.current.at(-1);
          if (focused) {
            const text = entryClipboardText(focused);
            const ok = copyToClipboard(text);
            setYankStatus(
              ok
                ? { text: `📋 copied ${text.length} chars`, kind: 'ok' }
                : { text: '⚠ copy needs a TTY (stdout redirected)', kind: 'warn' },
            );
          }
        } else if (isHome(input, key)) {
          sb?.scrollTo(0);
          setStickyScroll(false);
        } else if (isEnd(input, key)) {
          sb?.scrollTo(sb.scrollHeight);
          setStickyScroll(true);
        } else if (sb) {
          // Arrow/page scrolls disengage sticky follow; scrolling back to the
          // bottom edge re-arms it.
          setStickyScroll(isAtBottom(sb));
        }
        if (sb) refreshScrollPos();
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
    // useInput wouldn't pick up the new instance anyway.
    [setBrowse, refreshScrollPos],
  );
  useInput(onPaneKey, { isActive: active });

  // Imperative handle for jump shortcuts.
  useImperativeHandle(
    ref,
    (): MessageLogHandle => ({
      focusBottom: () => {
        const sb = scrollboxRef.current;
        if (!sb) return;
        sb.scrollTo(sb.scrollHeight);
        setStickyScroll(true);
        refreshScrollPos();
      },
      focusEntry: (id: string) => {
        const sb = scrollboxRef.current;
        if (sb && entries.some((e) => e.id === id)) {
          sb.scrollChildIntoView(id);
          refreshScrollPos();
        }
      },
    }),
    [entries, refreshScrollPos],
  );

  // Keep the hint honest as content grows/shrinks (new messages, streaming,
  // expand/collapse change heights too).
  useEffect(refreshScrollPos, [entries, view.expanded, refreshScrollPos]);

  const positionHint = scrollPos
    ? `↑ ${scrollPos.above} above · ↓ ${scrollPos.below} below${stickyScroll ? ' · following' : ''}`
    : '';
  const headerText = browseMode
    ? `BROWSE — ↑↓/PgUp/PgDn scroll · Tab expand · → expand · ← collapse · y copy · Home/End · Esc to type${positionHint ? '  ·  ' + positionHint : ''}`
    : `${positionHint ? positionHint + '  ·  ' : ''}Ctrl+E expand · Ctrl+P to browse`;
  // The copy/selection toast renders as its own colored segment (never dim)
  // so it stands out from the header hints in both light and dark terminals.
  const theme = getTheme();
  const toastColor = yankStatus?.kind === 'warn' ? theme.warning : theme.success;

  // Render one entry card. No clipping: the scrollbox handles overflow, so
  // every card renders its full body.
  const renderItem = (entry: LogEntry): React.ReactNode => (
    <MessageItem
      key={entry.id}
      entry={entry}
      expanded={view.expanded.has(entry.id)}
      agentRunning={agentRunning}
      columns={paneColumns}
      lineOffset={undefined}
      maxLines={undefined}
      onToggle={() => dispatch({ type: 'TOGGLE_EXPAND', id: entry.id })}
    />
  );

  // Flat card list (chat-cards design): one card per entry, 1 blank row
  // between cards. The scrollbox culls offscreen children, so rendering
  // every entry is cheap.
  const renderChunks = (): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) out.push(<Text key={`sp-${i}`}>{' '}</Text>);
      out.push(renderItem(entries[i]));
    }
    return out;
  };

  return (
    // Fixed total height (header 1 + body + spinner 1 = maxHeight). The
    // header stays pinned at top; the scrollbox pins to the bottom
    // (stickyStart) so a short conversation hugs the spinner/input — the
    // empty region, if any, sits between header and first card.
    <Box flexDirection="column" height={maxHeight ?? terminalRows}>
      {/* Header row: hints stay dim; the toast rides the same line in
          theme colors so it never shifts the rows below while visible. */}
      <Box flexDirection="row">
        <Text dimColor> {headerText}</Text>
        {yankStatus ? <Text color={toastColor}> {yankStatus.text}</Text> : null}
      </Box>
      <scrollbox
        ref={scrollboxRefCb}
        stickyScroll={stickyScroll}
        stickyStart="bottom"
        scrollY={true}
        width="100%"
        flexGrow={1}
        onMouseScroll={
          mouseEnabled
            ? (event: { scroll?: { direction?: string } }) => {
                // Native wheel (replaces StdinMouseBridge): up = older (-1),
                // down = newer (+1), one row step per event like the bridge.
                logTrace(`[mouse] wheel: ${event.scroll?.direction}`);
                const sb = scrollboxRef.current;
                const delta = event.scroll?.direction === 'up' ? -1 : 1;
                sb?.scrollBy(delta);
                // Up disengages bottom-follow; down re-engages once back at
                // the bottom edge.
                if (sb) {
                  if (delta < 0) setStickyScroll(false);
                  else if (isAtBottom(sb)) setStickyScroll(true);
                  refreshScrollPos();
                }
              }
            : undefined
        }
      >
        {renderChunks()}
        {entries.length === 0 ? <Text dimColor> No messages yet — type below to begin.</Text> : null}
        {/* Live streaming phases — subscribed to the StreamStore, so token
            deltas re-render only these panels, never the whole App. They
            render inside the scrollbox as full-size content: stickyScroll
            pins them to the bottom while streaming, and an unbounded
            response grows the scroll area instead of overflowing the
            fixed-height pane column (which drew over the input/spinner). */}
        {agentRunning ? <ThinkingPanel columns={paneColumns} /> : null}
        {agentRunning ? <ResponsePanel columns={paneColumns} /> : null}
      </scrollbox>
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
