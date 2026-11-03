import React from 'react';
import { Box, Text } from '../compat.js';
import type { LogEntry, LogEntryType } from '../state.js';
import {
  summarizeToolCall,
  summarizeToolResult,
  truncate,
  wrapIndent,
  type ToolSummary,
} from '../utils/toolSummary.js';
import { splitLinks } from '../utils/links.js';
import { markdownToLines } from '../utils/markdown.js';
import MarkdownBody from './MarkdownBody.js';
import { toolView, type SpecLine } from './toolViews/index.js';
import { getTheme } from '../theme.js';

/**
 * Maximum rendered body lines for a standard (non-card) entry when
 * collapsed. Must match the cap used by {@link MessageLog}'s
 * `estimateLines` so the viewport math agrees with the actual render.
 */
export const MAX_STANDARD_BODY_LINES = 3;

/**
 * Default body budget for assistant cards before expanding: the collapsed
 * agent card shows up to this many markdown lines (+N hint for the rest);
 * expanding removes the cap. Must match the estimator's count.
 */
export const MAX_ASSISTANT_BODY_LINES = 15;

/**
 * Props for the {@link MessageItem} component.
 */
export interface MessageItemProps {
  /** React list key (accepted explicitly — OpenTUI's JSX types require it on props). */
  key?: React.Key;
  /** The log entry to render. */
  entry: LogEntry;
  /** When true, this row is the focused item in the scroll viewport. */
  focused?: boolean;
  /** When true, render the full detail block instead of the collapsed card. */
  expanded?: boolean;
  /** Terminal width in columns, for header truncation and soft-wrapping. */
  columns?: number;
  /** True while an agent turn is streaming — reasoning renders unclipped. */
  agentRunning?: boolean;
  /**
   * Line scroll within this entry's body (when expanded taller than the
   * pane): skip this many wrapped body lines. Ignored unless `maxLines`
   * is also given.
   */
  lineOffset?: number;
  /** Cap on rendered body lines — the pane's viewport budget for this entry. */
  maxLines?: number;
  /**
   * Mouse interaction: a left-click (mousedown) on the entry's header row
   * toggles expand/collapse — same effect as Tab on the focused entry.
   * Only meaningful for card types (tool/tool_result/reasoning/assistant).
   */
  onToggle?: () => void;
}

/** Icon prefix for each log entry type. */
const ICONS: Record<LogEntryType, string> = {
  user: '❯',
  assistant: '●',
  reasoning: '💭',
  tool_call: '⎿',
  tool_result: '└',
  system: '·',
  shell: '$',
  plan: '▶',
  error: '✖',
  info: '·',
};

/**
 * Terminal cell width of a string: East-Asian wide / emoji count 2 cells,
 * zero-width joiners and variation selectors count 0. Header truncation
 * must budget by cells or wide icons overflow the row and garble the line
 * below.
 */
function displayWidth(str: string): number {
  const chars = [...str];
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) continue;
    // Emoji presentation (U+FE0F follows): ambiguous-width glyphs like ⚙ (U+2699)
    // render 2 cells when forced to emoji form.
    const emoji = (chars[i + 1]?.codePointAt(0) ?? 0) === 0xfe0f;
    if (
      emoji ||
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Per-tool icon for tool_call/tool_result entries (fallback: ⎿ / ↳). */
const TOOL_ICONS: Record<string, string> = {
  read: '📖',
  write: '📖',
  insert_lines: '📖',
  search_replace: '📖',
  list: '📖',
  grep: '🔍',
  glob: '🔍',
  bash: '⚙️',
};

/** First-result-line patterns that render an error result with ⚠ + red. */
const ERROR_RESULT_RE = /^(Error|ERROR|⚠)|WORKSPACE BOUNDARY/;

/** Icon for a tool entry: per-tool map, error override for results. */
function toolIcon(entry: LogEntry): string {
  if (entry.type === 'tool_result') {
    const first = (entry.toolResult ?? entry.content ?? '').split('\n')[0] ?? '';
    if (ERROR_RESULT_RE.test(first)) return '⚠';
    return TOOL_ICONS[entry.toolName ?? ''] ?? '↳';
  }
  return TOOL_ICONS[entry.toolName ?? ''] ?? '⎿';
}

/** Header color for a tool entry: red when the result is an error. */
function toolColor(entry: LogEntry, fallback: string): string {
  if (entry.type === 'tool_result') {
    const first = (entry.toolResult ?? entry.content ?? '').split('\n')[0] ?? '';
    if (ERROR_RESULT_RE.test(first)) return 'red';
  }
  return fallback;
}

/** Chalk color name for each log entry type, from the active theme. */
function entryColors(): Record<LogEntryType, string> {
  const theme = getTheme();
  return {
    user: theme.user,
    assistant: theme.assistant,
    reasoning: theme.reasoning,
    tool_call: theme.toolCall,
    tool_result: theme.toolResult,
    system: theme.system,
    shell: theme.toolResult,
    plan: theme.accent,
    error: theme.error,
    info: theme.system,
  };
}

/**
 * Formats timing information into a compact display string.
 *
 * @param timing - Optional timing data from the agent step.
 * @returns e.g. `" [45ms]"` or `" [1.2s | 120ms]"`, or empty string.
 */
function formatTiming(timing?: LogEntry['timing']): string {
  if (!timing) return '';
  const parts: string[] = [];
  if (timing.modelChatMs) {
    parts.push(`${(timing.modelChatMs / 1000).toFixed(1)}s`);
  }
  if (timing.toolCallMs) {
    parts.push(`${Math.round(timing.toolCallMs)}ms`);
  }
  return parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
}

/** Cards occupy 80% of the pane width (chat-cards design). */
export const CARD_WIDTH_RATIO = 0.8;
/** Card content width for a given pane width (must match the estimator). */
export const cardColumnsOf = (columns: number): number => Math.max(10, Math.floor(columns * CARD_WIDTH_RATIO));

/**
 * The chat-cards card: a borderless block with a background shade fill,
 * one header row (chevron + icon + title, right-aligned dim hints) and a
 * body that is a single ellipsized line when collapsed (chat-cards-design).
 *
 * The card is 80% of the pane wide; the shade fill covers the padding;
 * focus is expressed by lifting the fill to `theme.cardFocused` — there is
 * no `▸` marker char.
 */
function Card({
  background,
  icon,
  color,
  title,
  right,
  timing,
  expanded,
  expandable,
  columns,
  onToggle,
  children,
}: {
  background: string;
  icon: string;
  color: string;
  title: string;
  /** Dim right-aligned hint (e.g. `+12 lines`); empty when expanded. */
  right: string;
  timing: string;
  expanded: boolean;
  /** True when the body has more than the collapsed single line. */
  expandable: boolean;
  columns: number;
  onToggle?: () => void;
  children?: React.ReactNode;
}): React.ReactNode {
  const chev = expandable ? (expanded ? '⌃' : '⌄') : ' ';
  const rightText = `${right}${timing}`;
  // Header must fit the card width (padding 2 + chevron 2 + icon + space +
  // right side) or the overflowing row paints over the body below —
  // truncate the title to what's left, budgeting icons in terminal cells.
  const titleMax = Math.max(4, columns - 2 - 2 - displayWidth(icon) - 1 - displayWidth(rightText) - 1);
  return (
    // alignSelf: flex-start opts the card out of the pane column's default
    // stretch — without it the card grows to full pane width and the 80%
    // width (and with it the visible card edge + inner padding) is lost.
    <Box
      backgroundColor={background}
      paddingLeft={1}
      paddingRight={1}
      width={columns}
      alignSelf="flex-start"
      flexDirection="column"
    >
      <Box justifyContent="space-between" onMouseDown={onToggle ? () => onToggle() : undefined}>
        <Text color={color}>
          {chev} {icon} {truncate(title, titleMax)}
        </Text>
        <Text dimColor>{rightText}</Text>
      </Box>
      {children}
      {/* Inner bottom padding: one blank shaded row after the content. */}
      <Box height={1}>
        <Text> </Text>
      </Box>
    </Box>
  );
}

/**
 * The user message's own card (chat-cards design): same 80% width and
 * shade-fill language as {@link Card}, but right-aligned — the user's
 * messages anchor to the right edge of the pane against the left-anchored
 * agent cards. Kept as a separate component (not a Card variant) so the
 * mirroring can evolve independently.
 */
function UserCard({
  background,
  color,
  right,
  timing,
  expanded,
  expandable,
  columns,
  onToggle,
  children,
}: {
  background: string;
  color: string;
  /** Dim hint (e.g. `+12 lines`); empty when expanded. */
  right: string;
  timing: string;
  expanded: boolean;
  expandable: boolean;
  columns: number;
  onToggle?: () => void;
  children?: React.ReactNode;
}): React.ReactNode {
  const chev = expandable ? (expanded ? '⌃' : '⌄') : ' ';
  const rightText = `${right}${timing}`;
  return (
    <Box
      backgroundColor={background}
      paddingLeft={1}
      paddingRight={1}
      width={columns}
      alignSelf="flex-end"
      flexDirection="column"
    >
      <Box justifyContent="space-between" onMouseDown={onToggle ? () => onToggle() : undefined}>
        <Text color={color}>
          {chev} {ICONS.user} You
        </Text>
        <Text dimColor>{rightText}</Text>
      </Box>
      {children}
      {/* Inner bottom padding: one blank shaded row after the content. */}
      <Box height={1}>
        <Text> </Text>
      </Box>
    </Box>
  );
}

/** Render pre-wrapped tool-view spec lines (the expanded card body). */
function SpecBody({ lines }: { lines: SpecLine[] }): React.ReactNode {
  return (
    <Box marginLeft={2} flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color={l.color} dimColor={l.dim}>
          {l.text}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Render message body text with detected links underlined.
 *
 * Splits on {@link splitLinks} and wraps link segments in Ink's
 * `underline` style; plain segments keep the body colour.
 */
export function renderBodyWithLinks(body: string, bodyColor: string | undefined): React.ReactNode {
  // One <Text> per line: a single multi-line <text> node can draw over its
  // siblings; per-line nodes (MarkdownBody's shape) lay out reliably.
  return (
    <>
      {body.split('\n').map((line, i) => {
        const segments = splitLinks(line);
        if (!segments.some((s) => s.link)) {
          return <Text key={i} color={bodyColor}>{line}</Text>;
        }
        return (
          <Text key={i} color={bodyColor}>
            {segments.map((seg, j) =>
              seg.link ? (
                <Text key={j} underline>
                  {seg.text}
                </Text>
              ) : (
                <Text key={j}>{seg.text}</Text>
              ),
            )}
          </Text>
        );
      })}
    </>
  );
}

/** Flatten a laid-out MdLine's spans to plain text (collapsed card preview). */
function mdLineText(line: { spans: { text: string }[] } | undefined): string {
  if (!line) return '';
  return line.spans.map((s) => s.text).join('').trim();
}

/**
 * Renders a single {@link LogEntry}.
 *
 * Card types (chat-cards-design): user, tool_call, tool_result, reasoning
 * and assistant render as borderless background-shaded cards — fixed
 * collapsed height (header + one ellipsized body line + dim `+N lines`
 * hint, ⌄/⌃ chevron toggles), auto-height when expanded. Each family gets
 * its own shade fill. system/info/shell/error/plan stay plain dim lines.
 *
 * @example
 * ```tsx
 * <MessageItem entry={logEntry} focused={i === focusIndex} expanded={expandedSet.has(entry.id)} columns={80} />
 * ```
 */
export default function MessageItem({
  entry,
  focused = false,
  expanded = false,
  columns = 80,
  agentRunning = false,
  lineOffset = 0,
  maxLines,
  onToggle,
}: MessageItemProps): React.ReactNode {
  const theme = getTheme();
  const color = entryColors()[entry.type];
  const timing = formatTiming(entry.timing);
  const bg = focused ? theme.cardFocused : undefined;
  // Cards lay out against 80% of the pane width (see cardColumnsOf); plain
  // entries keep the full pane width.
  const cardCols = cardColumnsOf(columns);

  // Viewport clip: when the pane scrolls inside this entry (lineOffset) or
  // budgets its lines (maxLines), the rendered body is windowed to those
  // lines. Applies to every expanded body shape below.
  const clip = (text: string): string => {
    if (maxLines === undefined) return text;
    const lines = text.split('\n');
    return lines.slice(lineOffset, lineOffset + maxLines).join('\n');
  };

  // Same windowing for tool-view spec lines (see toolViews/index.tsx).
  const sliceSpec = (lines: SpecLine[]): SpecLine[] =>
    maxLines === undefined ? lines : lines.slice(lineOffset, lineOffset + maxLines);

  // --- Tool call / result card: smart summary title, spec-line body ---
  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    const summary: ToolSummary =
      entry.type === 'tool_call' ? summarizeToolCall(entry, cardCols) : summarizeToolResult(entry, cardCols);
    const view = toolView(entry.toolName);
    const lines = view.body(entry, cardCols);
    const hidden = lines.length - 1;
    return (
      <Card
        background={bg ?? theme.cardTool}
        icon={toolIcon(entry)}
        color={toolColor(entry, color)}
        title={summary.header}
        right={!expanded && hidden > 1 ? `+${hidden} lines` : ''}
        timing={timing}
        expanded={expanded}
        expandable={lines.length > 1}
        columns={cardCols}
        onToggle={onToggle}
      >
        {expanded && lines.length > 0 ? (
          <SpecBody lines={sliceSpec(lines)} />
        ) : lines.length > 0 ? (
          <Text dimColor>{`  ${truncate(lines[0].text.trim(), Math.max(4, cardCols - 4))}`}</Text>
        ) : null}
      </Card>
    );
  }

  // --- Reasoning card: streams in full while live; one-line preview after ---
  if (entry.type === 'reasoning') {
    const fullBody = wrapIndent(entry.content, 3, cardCols);
    const fullLines = fullBody.split('\n');
    const showFull = entry.live || expanded;
    const hidden = fullLines.length - 1;
    return (
      <Card
        background={bg ?? theme.cardReasoning}
        icon={ICONS.reasoning}
        color={color}
        title="thinking"
        right={!showFull && hidden > 1 ? `+${hidden} lines` : ''}
        timing=""
        expanded={showFull}
        expandable={fullLines.length > 1}
        columns={cardCols}
        onToggle={onToggle}
      >
        {showFull ? (
          <Box marginLeft={2}>{renderBodyWithLinks(clip(fullBody), 'gray')}</Box>
        ) : fullLines.length > 0 && fullLines[0].trim() ? (
          <Text dimColor>{`  ${truncate(fullLines[0].trim(), Math.max(4, cardCols - 4))}`}</Text>
        ) : null}
      </Card>
    );
  }

  // --- Standard entries ---
  // Plan banners stay theme-accented in the body (not dimmed gray) so the
  // current task is always visually distinct while a plan executes.
  const bodyColor =
    entry.type === 'error' ? 'red' : entry.type === 'system' || entry.type === 'info' || entry.type === 'shell' ? 'gray' : entry.type === 'plan' ? color : undefined;

  // --- User message card: `❯ You` header + markdown body, right-aligned
  // (UserCard — mirrored against the left-anchored agent cards). ---
  if (entry.type === 'user') {
    const allLines = markdownToLines(entry.content, Math.max(1, cardCols - 3));
    const shown = maxLines === undefined ? allLines : allLines.slice(lineOffset, lineOffset + maxLines);
    const hidden = allLines.length - 1;
    return (
      <UserCard
        background={bg ?? theme.cardUser}
        color={color}
        right={!expanded && hidden > 1 ? `+${hidden} lines` : ''}
        timing={timing}
        expanded={expanded}
        expandable={allLines.length > 1}
        columns={cardCols}
        onToggle={onToggle}
      >
        {expanded && allLines.length > 0 ? (
          <Box marginLeft={2}>
            <MarkdownBody lines={shown} color={color} />
          </Box>
        ) : allLines.length > 0 ? (
          <Text dimColor>{`  ${truncate(mdLineText(allLines[0]), Math.max(4, cardCols - 4))}`}</Text>
        ) : null}
      </UserCard>
    );
  }

  // --- Assistant message card: `● Agent` header + markdown body. Collapsed
  // shows up to MAX_ASSISTANT_BODY_LINES lines (not a single preview) — the
  // agent's answer is the main content of the chat; expanding removes the cap. ---
  if (entry.type === 'assistant') {
    const allLines = markdownToLines(entry.content, Math.max(1, cardCols - 3));
    const capped = !expanded ? allLines.slice(0, MAX_ASSISTANT_BODY_LINES) : allLines;
    const shown =
      maxLines === undefined ? capped : capped.slice(lineOffset, lineOffset + maxLines);
    const hidden = allLines.length - capped.length;
    return (
      <Card
        background={bg ?? theme.cardAssistant}
        icon={ICONS.assistant}
        color={color}
        title="Agent"
        right={!expanded && hidden > 0 ? `+${hidden} lines` : ''}
        timing={timing}
        expanded={expanded}
        expandable={allLines.length > MAX_ASSISTANT_BODY_LINES}
        columns={cardCols}
        onToggle={onToggle}
      >
        {capped.length > 0 ? (
          <Box marginLeft={2}>
            <MarkdownBody lines={shown} color={bodyColor} />
          </Box>
        ) : null}
      </Card>
    );
  }

  // --- Plain entries (system / info / shell / error / plan): dim wrapped
  // body, capped at MAX_STANDARD_BODY_LINES when collapsed. ---
  const fullBody = wrapIndent(entry.content, 3, columns);
  const fullLines = fullBody.split('\n');
  let body = clip(fullBody);
  let hiddenHint = '';
  const cappedType = entry.type === 'system' || entry.type === 'info' || entry.type === 'error' || entry.type === 'shell';
  if (cappedType && !expanded && fullLines.length > MAX_STANDARD_BODY_LINES) {
    body = fullLines.slice(0, MAX_STANDARD_BODY_LINES).join('\n');
    hiddenHint = `  ⤤ +${fullLines.length - MAX_STANDARD_BODY_LINES} lines`;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>
          {ICONS[entry.type]}{' '}
        </Text>
        {hiddenHint ? <Text dimColor>{hiddenHint}</Text> : null}
      </Box>
      {/* Column + one <Text> per wrapped line (same shape as MarkdownBody):
          a single multi-line <text> in a row box draws its lines over the
          following siblings on some widths (garbled interleaved rows). */}
      <Box marginLeft={3} flexDirection="column">
        {renderBodyWithLinks(body, bodyColor)}
      </Box>
    </Box>
  );
}
