/**
 * Line estimation & viewport math for the {@link MessageLog} pane.
 *
 * These functions MUST stay in sync with how {@link MessageItem} actually
 * renders, or the viewport will pack the wrong number of entries and the
 * pane will overflow/clip (visible as flicker/jump, or a pane that appears
 * stuck when an expanded entry dwarfs the viewport). Tool bodies are counted
 * through the toolViews registry — the same source the renderer draws from.
 *
 * Chat-cards semantics (chat-cards-design.md): tool_call / tool_result /
 * reasoning / assistant entries render as cards — 1 header row + body, where
 * a collapsed card's body is a single ellipsized line. User messages render
 * in full (right-aligned bubble); plain entries keep the capped wrapped body.
 */
import type { LogEntry } from '../../state.js';
import { MAX_STANDARD_BODY_LINES, MAX_ASSISTANT_BODY_LINES, cardColumnsOf } from '../MessageItem.js';
import { toolBodyLines } from '../toolViews/index.js';
import { markdownToLines } from '../../utils/markdown.js';

/** Indent applied to message bodies in MessageItem (must match the render). */
export const BODY_INDENT = 3;

/**
 * Count the rendered lines of a text block: each explicit newline is its
 * own line, plus soft-wrap chunks for lines longer than `usable` columns
 * (matching `wrapIndent`'s hard character chunking).
 */
export function wrappedLineCount(text: string, usable: number): number {
  return text
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / usable)), 0);
}

/** Card entry types: collapsed = header + one ellipsized body line. */
function isCardType(entry: LogEntry): boolean {
  return (
    entry.type === 'tool_call' ||
    entry.type === 'tool_result' ||
    entry.type === 'reasoning' ||
    entry.type === 'assistant' ||
    entry.type === 'user'
  );
}

/**
 * Total body lines of an entry (ignoring collapse/expand state) — the `+N`
 * hidden-line count and the expanded body height both come from here.
 */
function totalBodyLines(entry: LogEntry, columns: number): number {
  // Card bodies lay out against the card width (80% of the pane), not the
  // pane itself — mirror cardColumnsOf or the counts drift from the render.
  const cardCols = cardColumnsOf(columns);
  const usable = Math.max(1, cardCols - BODY_INDENT);
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    return toolBodyLines(entry, cardCols);
  }
  if (entry.type === 'reasoning') {
    return entry.content.length === 0 ? 0 : wrappedLineCount(entry.content, usable);
  }
  if (entry.type === 'user' || entry.type === 'assistant') {
    return markdownToLines(entry.content, usable).length;
  }
  return entry.content.length === 0 ? 0 : wrappedLineCount(entry.content, usable);
}

/**
 * Estimate the terminal lines a single entry occupies when rendered.
 *
 * - Cards (user / assistant / tool / reasoning): 1 header row + 1 body line
 *   when collapsed; 1 header row + the full body (from the same source the
 *   renderer draws: toolViews / markdownToLines) when expanded.
 * - system / info / error / shell: capped wrapped body when collapsed.
 */
export function estimateLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning = false, lineCap?: number): number {
  // Defensive: a malformed entry (null/undefined, or missing `type`/`content`)
  // must not crash the whole pane — count it as a single line and move on.
  if (!entry || typeof entry.type !== 'string' || typeof entry.content !== 'string') return 1;
  const total = totalBodyLines(entry, columns);
  const isOpen = expanded.has(entry.id);

  if (isCardType(entry)) {
    // Reasoning streams in full while its entry is live (thinking phase);
    // assistant cards show up to MAX_ASSISTANT_BODY_LINES lines even when
    // collapsed (the answer is the main content — see MessageItem).
    let bodyLines: number;
    if (entry.type === 'reasoning') bodyLines = entry.live || isOpen ? total : Math.min(total, 1);
    else if (entry.type === 'assistant') bodyLines = isOpen ? total : Math.min(total, MAX_ASSISTANT_BODY_LINES);
    else bodyLines = isOpen ? total : Math.min(total, 1);
    if (lineCap !== undefined) bodyLines = Math.min(bodyLines, lineCap);
    // +1 header row +1 inner bottom padding row (see Card/UserCard).
    return Math.max(1, 2 + bodyLines);
  }

  let bodyLines = isOpen ? total : Math.min(total, MAX_STANDARD_BODY_LINES);
  if (lineCap !== undefined) bodyLines = Math.min(bodyLines, lineCap);
  // Plain entries render body-only rows.
  return Math.max(1, bodyLines);
}

/**
 * The wrapped body-line count of an entry as currently rendered (expanded
 * state honoured). Used to decide when ↑/↓ should scroll inside the focused
 * entry instead of moving to its neighbours.
 */
export function renderedBodyLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning: boolean): number {
  // Defensive: a malformed entry must not crash the pane — count no body.
  if (!entry || typeof entry.type !== 'string' || typeof entry.content !== 'string') return 0;
  const total = totalBodyLines(entry, columns);
  const isOpen = expanded.has(entry.id);

  if (isCardType(entry)) {
    if (entry.type === 'reasoning') return entry.live || isOpen ? total : Math.min(total, 1);
    if (entry.type === 'assistant') return isOpen ? total : Math.min(total, MAX_ASSISTANT_BODY_LINES);
    return isOpen ? total : Math.min(total, 1);
  }
  return isOpen ? total : Math.min(total, MAX_STANDARD_BODY_LINES);
}

/** Lines of an entry's body the pane can show (1 pane header, 1 entry header). */
export const VISIBLE_BODY_BUDGET = (paneHeight: number): number => Math.max(1, paneHeight - 2);

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
export function computeWindow(
  entries: LogEntry[],
  focusIndex: number,
  paneHeight: number,
  columns: number,
  autoFollow: boolean,
  expanded: Set<string>,
  agentRunning: boolean,
  reserveLines = 0,
): Window {
  const n = entries.length;
  if (n === 0 || paneHeight <= 1) {
    return { startIndex: 0, endIndex: 0, linesAbove: 0, linesBelow: 0 };
  }
  // Rendered cost of an entry: its own estimate plus the 1-row gap rendered
  // between cards (every entry except the very first).
  const cost = (i: number, cap?: number): number =>
    estimateLines(entries[i], columns, expanded, agentRunning, cap) + (i > 0 ? 1 : 0);
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
  // Auto-follow: always show the tail. Budget reserves 1 row for the pane
  // header plus `reserveLines` for the live streaming panels rendered below
  // the cards (ThinkingPanel/ResponsePanel) — without the reserve the pane
  // overflows once the conversation fills it and cards draw over the panels.
  if (autoFollow) {
    const budget = paneHeight - 1 - reserveLines;
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
  const budget = paneHeight - 1 - reserveLines;
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
