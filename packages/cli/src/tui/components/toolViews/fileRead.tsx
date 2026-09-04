/**
 * FileReadView — `read`, plus the shared line-number gutter used by
 * FileWriteView.
 *
 * Call entry: `<path> · <range>` meta line.
 * Result entry: the runner prefixes `[FILE: path | TOTAL LINES: N | SHOWING:
 * a to b]` and numbers every row (`NNN: text`) — we re-gutter at our own
 * width, one visual line per row (truncate, no wrap → trivial estimator).
 */
import type { ToolView, SpecLine } from './index.js';
import { wrapSpec } from './index.js';
import { parseArgs } from '../../utils/toolSummary.js';

const MAX_ROWS = 100;

export interface GutterRow {
  n?: number;
  text: string;
}

/** Right-aligned number gutter + truncated content, one line per row. */
export function gutterLines(rows: GutterRow[], usable: number): SpecLine[] {
  const maxNum = rows.reduce((m, r) => Math.max(m, r.n ?? 0), 0);
  const gw = Math.max(2, String(maxNum).length);
  const body = usable - gw - 3;
  const out: SpecLine[] = [];
  for (const r of rows.slice(0, MAX_ROWS)) {
    const gutter = `${String(r.n ?? '').padStart(gw)} │ `;
    out.push({ text: gutter + (body > 4 ? r.text.slice(0, body) : r.text) });
  }
  if (rows.length > MAX_ROWS) out.push({ text: `… +${rows.length - MAX_ROWS} more (y to copy all)`, dim: true });
  return out;
}

const FILE_RE = /^\[FILE: (.+) \| TOTAL LINES: (\d+) \| SHOWING: (\d+) to (\d+)\]/;

export const fileReadView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_call') {
      const args = parseArgs(entry.toolArgs);
      const path = String(args?.path ?? '');
      let range = '';
      if (args?.startLine || args?.endLine) range = ` · L${args?.startLine ?? 1}-${args?.endLine ?? 'end'}`;
      else if (args?.first250) range = ' · first 250';
      else if (args?.last100) range = ' · last 100';
      return wrapSpec(path + range, columns);
    }
    const raw = entry.toolResult ?? entry.content ?? '';
    const head = raw.split('\n')[0] ?? '';
    const m = raw.match(FILE_RE);
    const rows: GutterRow[] = [];
    for (const line of raw.split('\n').slice(1)) {
      const rm = line.match(/^\s*(\d+): (.*)$/);
      rows.push(rm ? { n: Number(rm[1]), text: rm[2] } : { text: line });
    }
    if (!m) return wrapSpec(raw, columns); // unexpected shape → plain
    const meta = `${m[1]} · L${m[3]}-${m[4]} of ${m[2]}`;
    return [{ text: meta, dim: true }, ...gutterLines(rows, usable)];
  },
};
