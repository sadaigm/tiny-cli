/**
 * FileWriteView — `write`, `plan_write`, `create_skill`.
 *
 * Call entry: meta row (`<path> · +N lines · KB`) + content in the shared
 * numbered gutter (reused from fileRead). create_skill shows its
 * front-matter fields instead of a path meta. Result entry: plain text.
 */
import type { ToolView } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs } from '../../utils/toolSummary.js';
import { gutterLines } from './fileRead.js';

const MAX_META_LINES = 60;

function kb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

export const fileWriteView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_result') return wrapSpec(entry.toolResult ?? '', columns);

    const args = parseArgs(entry.toolArgs) ?? {};
    if (entry.toolName === 'create_skill') {
      const meta: string[] = [
        `skill ${String(args.name ?? '')}`,
        args.location ? `location ${String(args.location)}` : '',
        String(args.description ?? ''),
      ].filter(Boolean);
      const body = String(args.body ?? '');
      const lines = [
        ...meta.map((text) => ({ text, dim: true })),
        ...gutterLines(body.split('\n').map((text, i) => ({ n: i + 1, text })), usable),
      ];
      return lines.length <= MAX_META_LINES ? lines : [...lines.slice(0, MAX_META_LINES), { text: `… +${lines.length - MAX_META_LINES} more`, dim: true }];
    }

    const content = String(args.content ?? '');
    const lines = content.split('\n');
    return [
      { text: `${String(args.path ?? '')} · +${lines.length} lines · ${kb(content.length)}`, dim: true },
      ...gutterLines(lines.map((text, i) => ({ n: i + 1, text })), usable),
    ];
  },
};
