/**
 * DiffView — `search_replace`, `insert_lines`.
 *
 * Call entry: dim path header, `- ` red lines from the search block,
 * `+ ` green lines from the replace/insert content (cap 40).
 * Result entry: plain text (success / "not found" error).
 */
import type { ToolView, SpecLine } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs } from '../../utils/toolSummary.js';

const MAX_DIFF_LINES = 40;

export const diffView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_result') return wrapSpec(entry.toolResult ?? '', columns);

    const args = parseArgs(entry.toolArgs) ?? {};
    const cut = (s: string) => s.slice(0, usable - 2);
    const lines: SpecLine[] = [{ text: String(args.path ?? ''), dim: true }];
    let count = 0;
    const push = (text: string, color?: string) => {
      if (count >= MAX_DIFF_LINES) return;
      count++;
      lines.push({ text: cut(text), color });
    };
    if (entry.toolName === 'search_replace') {
      for (const l of String(args.search ?? '').split('\n')) push(`- ${l}`, 'red');
      for (const l of String(args.replace ?? '').split('\n')) push(`+ ${l}`, 'green');
    } else {
      // insert_lines
      const at = args.line !== undefined ? ` @ L${args.line} ${args.position ?? 'after'}` : '';
      lines[0] = { text: `${String(args.path ?? '')}${at}`, dim: true };
      for (const l of String(args.content ?? '').split('\n')) push(`+ ${l}`, 'green');
    }
    const total =
      (entry.toolName === 'search_replace'
        ? String(args.search ?? '') + String(args.replace ?? '')
        : String(args.content ?? '')
      ).split('\n').length;
    if (total > MAX_DIFF_LINES) lines.push({ text: `… +${total - MAX_DIFF_LINES} more`, dim: true });
    return lines;
  },
};
