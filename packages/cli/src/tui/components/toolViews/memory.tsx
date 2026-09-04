/**
 * MemoryView — `memory`.
 *
 * Call entry: `action name (type)` meta + content preview (first 10 lines,
 * dim). Result entry: plain text.
 */
import type { ToolView, SpecLine } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs } from '../../utils/toolSummary.js';

const MAX_PREVIEW = 10;

export const memoryView: ToolView = {
  body(entry, columns) {
    if (entry.type === 'tool_result') return wrapSpec(entry.toolResult ?? '', columns);
    const args = parseArgs(entry.toolArgs) ?? {};
    const head = [String(args.action ?? 'memory'), args.name ? String(args.name) : '', args.type ? `(${String(args.type)})` : '']
      .filter(Boolean)
      .join(' ');
    const lines: SpecLine[] = [{ text: head, dim: true }];
    if (args.description) lines.push({ text: String(args.description), dim: true });
    const content = String(args.content ?? '');
    if (content) {
      const preview = content.split('\n').slice(0, MAX_PREVIEW);
      lines.push(...preview.map((text) => ({ text, dim: true })));
      const total = content.split('\n').length;
      if (total > MAX_PREVIEW) lines.push({ text: `… +${total - MAX_PREVIEW} more`, dim: true });
    }
    return lines;
  },
};
