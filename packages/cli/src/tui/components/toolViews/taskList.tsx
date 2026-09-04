/**
 * TaskListView — `manage_tasks`, `mark_task_complete`.
 *
 * Call entry: action meta (+ task text/index). Result entry: task rows —
 * the plan file's `- [ ]` / `- [x]` markdown becomes ☐/☑ markers, completed
 * rows dimmed; other lines pass through.
 */
import type { ToolView, SpecLine } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs, wrapIndent } from '../../utils/toolSummary.js';

export const taskListView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_call') {
      const args = parseArgs(entry.toolArgs);
      const bits = [String(args?.action ?? 'tasks')];
      if (args?.taskText) bits.push(String(args.taskText));
      else if (args?.taskIndex !== undefined) bits.push(`#${String(args.taskIndex)}`);
      if (args?.notes) bits.push(`· ${String(args.notes)}`);
      return wrapSpec(bits.join(' '), columns);
    }
    const out = (entry.toolResult ?? '').trim();
    if (!out) return [];
    const lines: SpecLine[] = [];
    for (const raw of out.split('\n')) {
      const m = raw.match(/^\s*-\s\[( |x)\]\s(.*)$/);
      if (m) {
        lines.push(m[1] === 'x' ? { text: `☑ ${m[2]}`, dim: true } : { text: `☐ ${m[2]}` });
      } else if (raw.trim()) {
        lines.push(...wrapIndent(raw, 0, usable).split('\n').map((text) => ({ text, dim: true })));
      }
    }
    return lines.length > 0 ? lines : wrapSpec(out, columns);
  },
};
