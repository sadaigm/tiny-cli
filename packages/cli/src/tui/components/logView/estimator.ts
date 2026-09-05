/**
 * Line estimation & viewport math for the {@link MessageLog} pane.
 *
 * These functions MUST stay in sync with how {@link MessageItem} actually
 * renders, or the viewport will pack the wrong number of entries and the
 * pane will overflow/clip (visible as flicker/jump, or a pane that appears
 * stuck when an expanded entry dwarfs the viewport). Tool bodies are counted
 * through the toolViews registry — the same source the renderer draws from.
 */
import type { LogEntry } from '../../state.js';
import { MAX_STANDARD_BODY_LINES } from '../MessageItem.js';
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

/**
 * Estimate the terminal lines a single entry occupies when rendered.
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
export function estimateLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning = false, lineCap?: number, inTurn = false): number {
  const usable = Math.max(1, columns - BODY_INDENT);
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    if (!expanded.has(entry.id)) return 1;
    // Same view the renderer draws — the registry is the single source of
    // truth for tool body lines (toolViews/index.tsx).
    let lines = 1 + toolBodyLines(entry, columns);
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
export function renderedBodyLines(entry: LogEntry, columns: number, expanded: Set<string>, agentRunning: boolean): number {
  const usable = Math.max(1, columns - BODY_INDENT);
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    if (!expanded.has(entry.id)) return 0;
    return toolBodyLines(entry, columns);
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
export const VISIBLE_BODY_BUDGET = (paneHeight: number): number => Math.max(1, paneHeight - 2);

/**
 * Visible height of a turn group's rail: the sum of the members' rendered
 * lines, applying the same focused-entry cap the renderer applies — so the
 * rail is exactly as tall as the body beside it.
 */
export function railHeight(
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
export function computeWindow(
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
