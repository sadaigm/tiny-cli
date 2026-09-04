/**
 * FileListView — `glob`, `list`.
 *
 * Call entry: pattern / path meta. Result entry: `N files` meta row +
 * basenames (dim directory prefix), two columns when width allows, cap 100.
 */
import type { ToolView, SpecLine } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs } from '../../utils/toolSummary.js';

const MAX_ENTRIES = 100;

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}

export const fileListView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_call') {
      const args = parseArgs(entry.toolArgs);
      const meta = entry.toolName === 'glob' ? String(args?.pattern ?? '') : String(args?.path ?? '.');
      return wrapSpec(meta, columns);
    }
    const out = (entry.toolResult ?? '').trim();
    if (!out || /no (matches|files|entries)/i.test(out.split('\n')[0] ?? ''))
      return [{ text: out || '(no matches)', dim: true }];
    const files = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (files.length === 0) return [{ text: '(no matches)', dim: true }];
    const shown = files.slice(0, MAX_ENTRIES);
    const lines: SpecLine[] = [{ text: `${files.length} ${entry.toolName === 'glob' ? 'files' : 'entries'}`, dim: true }];
    const colW = Math.ceil(usable / 2);
    for (let i = 0; i < shown.length; i += usable >= 50 ? 2 : 1) {
      const cell = (f: string) => {
        const dir = dirOf(f);
        const base = f.slice(dir.length).slice(0, colW - dir.length - 1);
        return { dir, base };
      };
      const a = cell(shown[i]);
      const b = shown[i + 1] !== undefined && usable >= 50 ? cell(shown[i + 1]) : null;
      // Two-column packing: dir dim + basename normal per cell. SpecLine is
      // single-color, so dim dirs are dropped in columns and kept in single.
      if (b) {
        const pad = ' '.repeat(Math.max(1, colW - (a.base.length + a.dir.length)));
        lines.push({ text: `${a.dir}${a.base}${pad}${b.dir}${b.base}` });
      } else {
        lines.push(a.dir ? { text: `${a.dir}${a.base}` } : { text: a.base });
      }
    }
    if (files.length > MAX_ENTRIES) lines.push({ text: `… +${files.length - MAX_ENTRIES} more`, dim: true });
    return lines;
  },
};
