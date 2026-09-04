/**
 * AskUserView — `ask_user`.
 *
 * Call entry: context line + each question with its options. Result entry:
 * the runner's `N. question → selected` answer rows.
 */
import type { ToolView, SpecLine } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs, wrapIndent } from '../../utils/toolSummary.js';

export const askUserView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_result') return wrapSpec(entry.toolResult ?? '', columns);

    const args = parseArgs(entry.toolArgs) ?? {};
    const lines: SpecLine[] = [];
    if (args.context) lines.push({ text: String(args.context), dim: true });
    const questions = Array.isArray(args.questions) ? args.questions : [];
    for (const q of questions) {
      const item = q as { question?: string; options?: string[] };
      lines.push({ text: `? ${String(item.question ?? '')}` });
      for (const opt of item.options ?? []) {
        lines.push(...wrapIndent(`· ${String(opt)}`, 2, usable).split('\n').map((text) => ({ text, dim: true })));
      }
    }
    return lines;
  },
};
