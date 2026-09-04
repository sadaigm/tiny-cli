/**
 * Per-tool expanded-body views (see output_messages_component_impl_task.md).
 *
 * A ToolView turns an entry into styled, pre-wrapped body lines. MessageItem
 * renders those lines (windowed by the pane's lineOffset/maxLines clip) and
 * MessageLog's estimator counts the SAME array (`toolBodyLines`) — render and
 * estimate share one source so the viewport math can never drift.
 *
 * Tools without a view fall back to the classic gray detail blob.
 */
import type { LogEntry } from '../../state.js';
import { summarizeToolCall, summarizeToolResult, wrapIndent } from '../../utils/toolSummary.js';
import { bashView } from './bash.js';
import { grepView } from './grep.js';
import { fileReadView } from './fileRead.js';
import { fileWriteView } from './fileWrite.js';
import { diffView } from './diff.js';
import { fileListView } from './fileList.js';
import { taskListView } from './taskList.js';
import { askUserView } from './askUser.js';
import { memoryView } from './memory.js';

/** One rendered body line. Color/dim map to compat <Text> props. */
export interface SpecLine {
  text: string;
  color?: string;
  dim?: boolean;
}

export interface ToolView {
  /** Styled body lines for the expanded state, wrapped to `columns`. */
  body(entry: LogEntry, columns: number): SpecLine[];
}

/** Wrap raw text into plain (or dim) spec lines at the body indent width. */
export function wrapSpec(text: string, columns: number, dim = true): SpecLine[] {
  return wrapIndent(text, 0, columns - 3).split('\n').map((t) => ({ text: t, dim }));
}

/** Fallback: today's uniform gray detail block. */
const fallbackView: ToolView = {
  body(entry, columns) {
    const detail =
      entry.type === 'tool_call'
        ? summarizeToolCall(entry, columns).detail
        : summarizeToolResult(entry, columns).detail;
    if (!detail) return [];
    return wrapSpec(detail, columns);
  },
};

const views: Record<string, ToolView> = {
  bash: bashView,
  grep: grepView,
  read: fileReadView,
  write: fileWriteView,
  plan_write: fileWriteView,
  create_skill: fileWriteView,
  search_replace: diffView,
  insert_lines: diffView,
  glob: fileListView,
  list: fileListView,
  manage_tasks: taskListView,
  mark_task_complete: taskListView,
  ask_user: askUserView,
  memory: memoryView,
};

/** Failed results (runner convention: result text starts with Error/…) render red. */
function isFailedResult(entry: LogEntry): boolean {
  if (entry.type !== 'tool_result') return false;
  return /^(Error|error)[: ]/.test((entry.toolResult ?? entry.content ?? '').trimStart());
}

export function toolView(toolName?: string): ToolView {
  const base = (toolName && views[toolName]) || fallbackView;
  return {
    body(entry, columns) {
      const lines = base.body(entry, columns);
      return isFailedResult(entry) ? lines.map((l) => ({ ...l, color: 'red' })) : lines;
    },
  };
}

/** Estimator contract: the exact line count the renderer draws. */
export function toolBodyLines(entry: LogEntry, columns: number): number {
  return toolView(entry.toolName).body(entry, columns).length;
}
