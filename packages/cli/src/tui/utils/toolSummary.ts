/**
 * Per-tool argument summarization for the conversation log.
 *
 * The raw `toolArgs` of a tool call (a JSON string) is often huge — a
 * `write` call carries the entire file `content`, a `plan_write` call an
 * entire document. Rendering these verbatim swallows the screen.
 *
 * This module extracts, for each known tool, the one short field that
 * actually identifies the operation (a path, a command, a pattern) and
 * produces a compact one-line header. The full detail is only rendered
 * when the user expands the entry.
 *
 * All functions are pure and defensive (bad JSON falls back to a capped
 * raw representation) so they are safe to call on any `LogEntry`.
 */
import type { LogEntry } from '../state.js';

/** Maximum lines shown in an expanded detail block. */
export const MAX_DETAIL_LINES = 40;

/** Maximum length of a collapsed summary header (before the +N hint). */
export const MAX_HEADER_WIDTH = 80;

/** Result of summarizing a tool call / result for rendering. */
export interface ToolSummary {
  /** One-line summary shown when collapsed (e.g. `write  src/foo.ts`). */
  header: string;
  /** Multi-line detail block shown when expanded (undefined if nothing extra). */
  detail?: string;
  /** Number of content lines hidden in the collapsed view (for the `⤤ +N` hint). */
  hiddenLineCount: number;
}

/**
 * Parse a tool's raw JSON args string into an object, defensively.
 *
 * @returns The parsed args, or `null` if the string is not valid JSON / empty.
 */
export function parseArgs(toolArgs?: string): Record<string, unknown> | null {
  if (!toolArgs) return null;
  try {
    const parsed = JSON.parse(toolArgs);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Shorten a string to `max` characters with an ellipsis. */
function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Basename of a path (last segment), for compact display. */
function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/** Count the number of lines in a string (trailing newline → one more line). */
function lineCount(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}

/** Cap a multi-line string to the first N lines, with a `… +M more` footer. */
function capLines(value: string, max: number): string {
  const lines = value.split(/\r?\n/);
  if (lines.length <= max) return value;
  const head = lines.slice(0, max);
  return `${head.join('\n')}\n… +${lines.length - max} more lines`;
}

/**
 * Summarize a tool-call {@link LogEntry} into a compact header plus an
 * optional expanded-detail block.
 *
 * The "meaningful field" is chosen per tool name:
 * - `write` / `plan_write` → `path` (+ content line count)
 * - `read` → `path` (+ range flags)
 * - `search_replace` → `path` (+ first line of `search`)
 * - `insert_lines` → `path` @ `line`
 * - `list` → `path`
 * - `bash` → `cmd`
 * - `grep` → `pattern` in `path`
 * - `glob` → `pattern`
 * - `ask_user` → first question (+ full questionnaire in detail)
 *
 * Unknown tools fall back to a capped raw-args representation.
 *
 * @param entry - The tool_call or tool_result log entry.
 * @param columns - Terminal width, used to cap the header.
 * @returns A {@link ToolSummary}.
 */
export function summarizeToolCall(entry: LogEntry, columns: number): ToolSummary {
  const toolName = entry.toolName ?? '';
  const args = parseArgs(entry.toolArgs);
  const cap = Math.min(columns > 0 ? columns - 2 : MAX_HEADER_WIDTH, MAX_HEADER_WIDTH);
  const str = (k: string): string | undefined => {
    const v = args?.[k];
    return typeof v === 'string' ? v : v == null ? undefined : String(v);
  };

  switch (toolName) {
    case 'write':
    case 'plan_write': {
      const filePath = str('path') ?? '<no path>';
      const content = str('content') ?? '';
      const lines = lineCount(content);
      const suffix = lines > 1 ? `  ⤤ +${lines} lines` : '';
      const prefix = `${toolName}  `;
      // Cap the path so prefix + path + suffix fits the width budget.
      const pathBudget = Math.max(4, cap - prefix.length - suffix.length);
      const header = `${prefix}${truncate(basename(filePath), pathBudget)}${suffix}`;
      return {
        header,
        detail: content ? capLines(content, MAX_DETAIL_LINES) : undefined,
        hiddenLineCount: lines,
      };
    }
    case 'read': {
      const filePath = str('path') ?? '<no path>';
      let suffix = '';
      if (str('first250')) suffix = ' · first250';
      else if (str('last100')) suffix = ' · last100';
      return {
        header: `read  ${truncate(basename(filePath), cap)}${suffix}`,
        hiddenLineCount: 0,
      };
    }
    case 'search_replace': {
      const filePath = str('path') ?? '<no path>';
      const search = str('search') ?? '';
      const firstLine = search.split(/\r?\n/)[0] ?? '';
      return {
        header: `search_replace  ${truncate(basename(filePath), cap)}  ‹${truncate(firstLine, 30)}›`,
        detail: search
          ? `search:\n${capLines(search, MAX_DETAIL_LINES)}\n\nreplace:\n${capLines(str('replace') ?? '', MAX_DETAIL_LINES)}`
          : undefined,
        hiddenLineCount: lineCount(search) + lineCount(str('replace')),
      };
    }
    case 'insert_lines': {
      const filePath = str('path') ?? '<no path>';
      const line = str('line');
      const content = str('content') ?? '';
      return {
        header: `insert_lines  ${truncate(basename(filePath), cap)}${line ? ` @${line}` : ''}`,
        detail: content ? capLines(content, MAX_DETAIL_LINES) : undefined,
        hiddenLineCount: lineCount(content),
      };
    }
    case 'list': {
      return { header: `list  ${truncate(str('path') ?? '<no path>', cap)}`, hiddenLineCount: 0 };
    }
    case 'bash': {
      const cmd = str('cmd') ?? '';
      return {
        header: `bash  $ ${truncate(cmd, cap)}`,
        detail: cmd ? capLines(cmd, MAX_DETAIL_LINES) : undefined,
        hiddenLineCount: lineCount(cmd) > 1 ? lineCount(cmd) : 0,
      };
    }
    case 'grep': {
      const pattern = str('pattern') ?? '';
      const path = str('path') ?? '';
      return {
        header: `grep  ${truncate(pattern, cap)}${path ? `  in ${truncate(basename(path), 24)}` : ''}`,
        hiddenLineCount: 0,
      };
    }
    case 'glob': {
      return { header: `glob  ${truncate(str('pattern') ?? '<no pattern>', cap)}`, hiddenLineCount: 0 };
    }
    case 'ask_user': {
      // Questions arrive as a nested array on the args object. Pull the
      // first question for the header and render the full questionnaire
      // as a readable list for the expanded detail block.
      const questions = Array.isArray(args?.questions)
        ? (args.questions as Array<Record<string, unknown>>)
        : [];
      const first = questions[0];
      const firstQuestion =
        typeof first?.question === 'string' ? first.question : '<no question>';
      // Reserve room for the "ask_user  Q1: " prefix inside the cap.
      const qBudget = Math.max(4, cap - 'ask_user  Q1: '.length);
      const header = `ask_user  Q1: ${truncate(firstQuestion, qBudget)}`;
      const detail =
        questions.length > 0
          ? capLines(
              questions
                .map((q, i) => {
                  const questionText =
                    typeof q?.question === 'string' ? q.question : '<no question>';
                  const opts = Array.isArray(q?.options)
                    ? (q.options as unknown[]).filter(
                        (o): o is string => typeof o === 'string',
                      )
                    : [];
                  return `Q${i + 1}: ${questionText}\n${opts
                    .map((o) => `  - ${o}`)
                    .join('\n')}`;
                })
                .join('\n'),
              MAX_DETAIL_LINES,
            )
          : undefined;
      return { header, detail, hiddenLineCount: 0 };
    }
    case 'mark_task_complete':
    case 'manage_tasks': {
      const action = str('action') ?? str('notes') ?? '';
      return {
        header: `${toolName}${action ? `  ${truncate(action, cap)}` : ''}`,
        hiddenLineCount: 0,
      };
    }
    default: {
      // Fallback: show a capped raw representation.
      const raw = entry.toolArgs ?? entry.content;
      return {
        header: `${toolName || 'tool'}  ${truncate(raw, cap)}`,
        detail: raw ? capLines(raw, MAX_DETAIL_LINES) : undefined,
        hiddenLineCount: lineCount(raw),
      };
    }
  }
}

/**
 * Summarize a tool-result entry into a compact header plus optional detail.
 *
 * @param entry - The tool_result log entry.
 * @param columns - Terminal width, used to cap the header.
 */
export function summarizeToolResult(entry: LogEntry, columns: number): ToolSummary {
  const text = entry.toolResult ?? entry.content ?? '';
  const cap = Math.min(columns > 0 ? columns - 2 : MAX_HEADER_WIDTH, MAX_HEADER_WIDTH);
  const lines = lineCount(text);
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  return {
    header: `↳ ${truncate(firstLine, cap)}`,
    detail: text ? capLines(text, MAX_DETAIL_LINES) : undefined,
    hiddenLineCount: lines,
  };
}

/**
 * Soft-wrap a string to fit within `width` columns, indenting every
 * continuation line by `indent` spaces. Existing newlines are preserved.
 *
 * Ink does not auto-wrap text, so this is used for user/assistant output
 * and expanded detail blocks to keep paragraphs readable.
 *
 * @param text - The text to wrap.
 * @param indent - Number of leading spaces on each line.
 * @param width - Total available width (including the indent).
 * @returns The wrapped, indented string.
 */
export function wrapIndent(text: string, indent: number, width: number): string {
  // Clamp to at least 1 so a too-narrow terminal still wraps (each char on
  // its own line) rather than disabling wrapping entirely.
  const usable = Math.max(1, width - indent);
  const pad = ' '.repeat(indent);
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.length <= usable) return `${pad}${line}`;
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += usable) {
        chunks.push(line.slice(i, i + usable));
      }
      return chunks.map((c) => `${pad}${c}`).join('\n');
    })
    .join('\n');
}
