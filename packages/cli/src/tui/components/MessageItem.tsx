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
}

/** Icon prefix for each log entry type. */
const ICONS: Record<LogEntryType, string> = {
  user: '❯',
  assistant: '🤖',
  tool_call: '🔧',
  tool_result: '↳',
  system: 'ℹ',
  error: '✖',
  info: 'ℹ',
};

/** Chalk color name for each log entry type, from the active theme. */
function entryColors(): Record<LogEntryType, string> {
  const theme = getTheme();
  return {
    user: theme.user,
    assistant: theme.assistant,
    tool_call: theme.toolCall,
    tool_result: theme.toolResult,
    system: theme.system,
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
          <Text dimColor>{wrapIndent(summary.detail, 0, columns - 3)}</Text>
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
function renderBodyWithLinks(body: string, bodyColor: string | undefined): React.ReactElement {
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
}: MessageItemProps): React.ReactElement {
  const color = entryColors()[entry.type];
  const timing = formatTiming(entry.timing);
  const marker = focused ? '▸ ' : '  ';

  // --- Tool call: smart summary, one-line when collapsed ---
  if (entry.type === 'tool_call') {
    const summary = summarizeToolCall(entry, columns);
    return renderToolSummary(summary, ICONS.tool_call, color, timing, expanded, focused, columns);
  }

  // --- Tool result: first line when collapsed, full when expanded ---
  if (entry.type === 'tool_result') {
    const summary = summarizeToolResult(entry, columns);
    return renderToolSummary(summary, ICONS.tool_result, color, timing, expanded, focused, columns);
  }

  // --- Standard entries: header + soft-wrapped, indented body ---
  const bodyColor =
    entry.type === 'error' ? 'red' : entry.type === 'system' || entry.type === 'info' ? 'gray' : undefined;

  // Cap the body when collapsed so a single giant entry (e.g. a captured
  // file dump or hydration log) can't dominate the pane and cause redraw
  // flicker. The full text is shown only when expanded.
  const fullBody = wrapIndent(entry.content, 3, columns);
  const fullLines = fullBody.split('\n');
  let body = fullBody;
  let hiddenHint = '';
  if (!expanded && fullLines.length > MAX_STANDARD_BODY_LINES) {
    body = fullLines.slice(0, MAX_STANDARD_BODY_LINES).join('\n');
    hiddenHint = `  ⤤ +${fullLines.length - MAX_STANDARD_BODY_LINES} lines`;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>
          {marker}
          {ICONS[entry.type]} {entry.type === 'user' ? 'You' : entry.type === 'assistant' ? 'Agent' : ''}
          {entry.type === 'user' || entry.type === 'assistant' ? ':' : ''}
        </Text>
        {entry.type === 'assistant' && timing ? <Text dimColor>{timing}</Text> : null}
        {entry.queued ? <Text dimColor color="yellow"> (queued)</Text> : null}
        {hiddenHint ? <Text dimColor>{hiddenHint}</Text> : null}
      </Box>
      <Box marginLeft={3}>
        {renderBodyWithLinks(body, bodyColor)}
      </Box>
    </Box>
  );
}
