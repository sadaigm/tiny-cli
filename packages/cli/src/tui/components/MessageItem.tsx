import React from 'react';
import { Box, Text } from 'ink';
import type { LogEntry, LogEntryType } from '../state.js';
import {
  summarizeToolCall,
  summarizeToolResult,
  wrapIndent,
  type ToolSummary,
} from '../utils/toolSummary.js';
import { splitLinks } from '../utils/links.js';
import { markdownToLines } from '../utils/markdown.js';
import MarkdownBody from './MarkdownBody.js';
import { getTheme } from '../theme.js';

/**
 * Maximum rendered body lines for a standard (non-tool) entry when
 * collapsed. Must match the cap used by {@link MessageLog}'s
 * `estimateLines` so the viewport math agrees with the actual render.
 */
export const MAX_STANDARD_BODY_LINES = 3;

/**
 * Props for the {@link MessageItem} component.
 */
export interface MessageItemProps {
  /** The log entry to render. */
  entry: LogEntry;
  /** When true, this row is the focused item in the scroll viewport. */
  focused?: boolean;
  /** When true, render the full detail block instead of the one-line summary. */
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
   * True when this entry renders inside an agent turn group (MessageLog's
   * rail). Turn members suppress their own header row — the group header
   * (`● Agent · gist … meta`) is the single header for the whole turn.
   */
  inTurn?: boolean;
}

/** Icon prefix for each log entry type. */
const ICONS: Record<LogEntryType, string> = {
  user: '❯',
  assistant: '●',
  reasoning: '⋯',
  tool_call: '⎿',
  tool_result: '└',
  system: '·',
  plan: '▶',
  error: '✖',
  info: '·',
};

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
    plan: theme.accent,
    error: theme.error,
    info: theme.system,
  };
}

/**
 * Formats timing information into a compact display string.
 *
 * @param timing - Optional timing data from the agent step.
 * @returns e.g. `" [45ms]"` or `" [AI: 1.2s | 120ms]"`, or empty string.
 */
function formatTiming(timing?: LogEntry['timing']): string {
  if (!timing) return '';
  const parts: string[] = [];
  if (timing.modelChatMs) {
    parts.push(`AI: ${(timing.modelChatMs / 1000).toFixed(1)}s`);
  }
  if (timing.toolCallMs) {
    parts.push(`${Math.round(timing.toolCallMs)}ms`);
  }
  return parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
}

/**
 * Renders a tool summary header (collapsed) or header + detail (expanded).
 *
 * Used for both `tool_call` and `tool_result` entries via their respective
 * summarizers from {@link toolSummary}.
 */
function renderToolSummary(
  summary: ToolSummary,
  icon: string,
  color: string,
  timing: string,
  expanded: boolean,
  focused: boolean,
  columns: number,
  clip?: (text: string) => string,
): React.ReactElement {
  const marker = focused ? '▸ ' : '  ';
  const hint = !expanded && summary.hiddenLineCount > 1 ? `  ⤤ +${summary.hiddenLineCount} lines` : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>
          {marker}
          {icon} {summary.header}
        </Text>
        <Text dimColor>
          {hint}
          {timing}
          {expanded && summary.detail ? '  ⤤ collapse' : ''}
        </Text>
      </Box>
      {expanded && summary.detail ? (
        <Box marginLeft={3}>
          <Text dimColor>{clip ? clip(wrapIndent(summary.detail, 0, columns - 3)) : wrapIndent(summary.detail, 0, columns - 3)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Render message body text with detected links underlined.
 *
 * Splits on {@link splitLinks} and wraps link segments in Ink's
 * `underline` style; plain segments keep the body colour.
 */
export function renderBodyWithLinks(body: string, bodyColor: string | undefined): React.ReactElement {
  const segments = splitLinks(body);
  if (!segments.some((s) => s.link)) {
    return <Text color={bodyColor}>{body}</Text>;
  }
  return (
    <Text color={bodyColor}>
      {segments.map((seg, i) =>
        seg.link ? (
          <Text key={i} underline>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}

/**
 * Renders a single {@link LogEntry} with appropriate color, icon, and a
 * collapsed/expanded layout driven by {@link toolSummary}.
 *
 * Rendering rules per entry type:
 * - **tool_call**: smart per-tool summary (path/cmd/pattern), one line when
 *   collapsed; full args when expanded. The raw `toolArgs` blob is never
 *   dumped inline.
 * - **tool_result**: first line when collapsed (+ `⤤ +N` hint); full result
 *   when expanded.
 * - **user** / **assistant** / **system** / **info** / **error**: header
 *   prefix with soft-wrapped, indented body text.
 *
 * When `focused` is true the row is prefixed with `▸` so the user can see
 * which entry keyboard navigation (↑/↓) is currently on.
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
  inTurn = false,
}: MessageItemProps): React.ReactElement {
  const color = entryColors()[entry.type];
  const timing = formatTiming(entry.timing);
  const marker = focused ? '▸ ' : '  ';

  // Viewport clip: when the pane scrolls inside this entry (lineOffset) or
  // budgets its lines (maxLines), the rendered body is windowed to those
  // lines. Applies to every expanded body shape below.
  const clip = (text: string): string => {
    if (maxLines === undefined) return text;
    const lines = text.split('\n');
    return lines.slice(lineOffset, lineOffset + maxLines).join('\n');
  };

  // --- Tool call: smart summary, one-line when collapsed ---
  if (entry.type === 'tool_call') {
    const summary = summarizeToolCall(entry, columns);
    return renderToolSummary(summary, ICONS.tool_call, color, timing, expanded, focused, columns, clip);
  }

  // --- Tool result: first line when collapsed, full when expanded ---
  if (entry.type === 'tool_result') {
    const summary = summarizeToolResult(entry, columns);
    return renderToolSummary(summary, ICONS.tool_result, color, timing, expanded, focused, columns, clip);
  }

  // --- Reasoning: streams in full while its entry is live (thinking
  // phase); collapses to a one-line section (Tab to expand) as soon as the
  // turn moves on to text or tool calls ---
  if (entry.type === 'reasoning') {
    const fullBody = wrapIndent(entry.content, 3, columns);
    const fullLines = fullBody.split('\n');
    const showFull = entry.live || expanded;
    const body = showFull
      ? clip(fullBody)
      : fullLines.slice(0, 1).join('\n');
    const hiddenHint = showFull || fullLines.length <= 1 ? '' : `  ⤤ +${fullLines.length - 1} lines`;
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color}>
            {marker}
            {ICONS[entry.type]} thinking{expanded ? '  ⤤ collapse' : ''}
          </Text>
          {hiddenHint ? <Text dimColor>{hiddenHint}</Text> : null}
        </Box>
        <Box marginLeft={3}>
          {renderBodyWithLinks(body, 'gray')}
        </Box>
      </Box>
    );
  }

  // --- Standard entries: header + soft-wrapped, indented body ---
  // Plan banners stay theme-accented in the body (not dimmed gray) so the
  // current task is always visually distinct while a plan executes.
  const bodyColor =
    entry.type === 'error' ? 'red' : entry.type === 'system' || entry.type === 'info' ? 'gray' : entry.type === 'plan' ? color : undefined;

  // Markdown bodies (user/assistant): layout happens in the pure util —
  // clipping is a line-array slice (lineOffset/maxLines index MdLines), so
  // MessageLog's estimator counts the exact same rows it draws. Plain
  // entries keep the wrapIndent-based path (see the branches above).
  if (entry.type === 'user' || entry.type === 'assistant') {
    const allLines = markdownToLines(entry.content, Math.max(1, columns - 3));
    const bodyLines = maxLines === undefined ? allLines : allLines.slice(lineOffset, lineOffset + maxLines);
    // Turn members (assistant inside a rail) render body-only: the group
    // header is the turn's single header.
    if (entry.type === 'assistant' && inTurn) {
      return (
        <Box marginLeft={1}>
          <MarkdownBody lines={bodyLines} color={bodyColor} />
        </Box>
      );
    }
    // User rows are the chat "bubble": right-aligned, user-coloured — the
    // visual contrast against left-anchored agent turns (chat-redesign).
    if (entry.type === 'user') {
      return (
        <Box flexDirection="column" alignItems="flex-end">
          <Box>
            <Text color={color}>
              {marker}
              {`${ICONS.user} `}
            </Text>
            <Box alignItems="flex-end">
              <MarkdownBody lines={bodyLines} color={color} />
            </Box>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color}>
            {marker}
            {`${ICONS[entry.type]} Agent`}
          </Text>
          {timing ? <Text dimColor>{timing}</Text> : null}
          {entry.queued ? <Text dimColor color="yellow"> (queued)</Text> : null}
        </Box>
        <Box marginLeft={3}>
          <MarkdownBody lines={bodyLines} color={bodyColor} />
        </Box>
      </Box>
    );
  }

  // Cap the body when collapsed so a giant entry (e.g. a captured file dump
  // or hydration log) can't dominate the pane and cause redraw flicker.
  // The full text is shown only when expanded.
  const fullBody = wrapIndent(entry.content, 3, columns);
  const fullLines = fullBody.split('\n');
  let body = clip(fullBody);
  let hiddenHint = '';
  const cappedType = entry.type === 'system' || entry.type === 'info' || entry.type === 'error';
  if (cappedType && !expanded && fullLines.length > MAX_STANDARD_BODY_LINES) {
    body = fullLines.slice(0, MAX_STANDARD_BODY_LINES).join('\n');
    hiddenHint = `  ⤤ +${fullLines.length - MAX_STANDARD_BODY_LINES} lines`;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>
          {marker}
          {ICONS[entry.type]}{' '}
        </Text>
        {hiddenHint ? <Text dimColor>{hiddenHint}</Text> : null}
      </Box>
      <Box marginLeft={3}>
        {renderBodyWithLinks(body, bodyColor)}
      </Box>
    </Box>
  );
}
