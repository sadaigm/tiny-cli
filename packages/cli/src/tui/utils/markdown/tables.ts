import type { MdLine, MdSpan } from './types.js';
import { strWidth } from './width.js';
import { parseInline } from './inline.js';
import { wrapSpans } from './wrap.js';

/** Matches a GFM delimiter cell: `---`, `---:`, `:--`, `:--:` etc. */
const DELIMITER_CELL = /^:?-+:?$/;

/** True when the line is a table row candidate (pipe-delimited cells). */
export function isPipeRow(line: string): boolean {
  return line.includes('|') && line.trim() !== '';
}

/** True when the line is a table delimiter row. */
export function isDelimiterRow(line: string): boolean {
  if (!isPipeRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL.test(c));
}

/** Split a `| a | b |` row into trimmed cell texts (outer pipes optional). */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Unescape `\|` inside cells so pipe characters render in the grid.
  return splitCells(s).map((c) => c.trim());
}

/** Split on unescaped pipes (backslash-pipe renders as a literal pipe). */
function splitCells(s: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur);
  return cells;
}

/** Columns consumed by the grid chrome: borders + inter-cell padding. */
function gridOverhead(cols: number): number {
  // `| ` + ` | ` × (cols-1) + ` |`
  return 2 + (cols - 1) * 3 + 2;
}

/**
 * Lay a GFM pipe table out as aligned terminal rows and push them onto
 * `lines`. `bodyRows` are the raw row lines after the delimiter row;
 * `header` is the already-split header row.
 *
 * Header spans are bold; the delimiter row becomes a dim `hr` rule that
 * mirrors the grid chrome exactly. Column widths: natural (longest cell)
 * when the grid fits `w`; otherwise shrunk proportionally (min 1) and
 * cells word-wrap. When even one column per cell cannot fit (ultra-narrow
 * terminal), the table falls back to plain wrapped text — content is
 * never eaten.
 */
export function emitTable(lines: MdLine[], bodyRows: string[], header: string[], w: number): void {
  const body = bodyRows.map(splitTableRow);
  const cols = Math.max(header.length, ...body.map((r) => r.length));
  if (cols === 0) return;

  const natural: number[] = [];
  for (let c = 0; c < cols; c++) {
    natural[c] = Math.max(
      1,
      strWidth(header[c] ?? ''),
      ...body.map((r) => strWidth(r[c] ?? '')),
    );
  }

  // Ultra-narrow terminal: even 1 column per cell cannot fit — plain text.
  if (gridOverhead(cols) >= w) {
    for (const rowText of [header.join(' | '), ...body.map((r) => r.join(' | '))]) {
      for (const spans of wrapSpans(parseInline(rowText), w)) {
        lines.push({ style: 'text', indent: 0, spans });
      }
    }
    return;
  }

  // Natural widths when they fit; otherwise shrink proportionally (min 1).
  let widths = natural.slice();
  const total = sum(widths) + gridOverhead(cols);
  if (total > w) {
    const excess = total - w;
    const shrinkable = sum(widths);
    widths = widths.map((x) => Math.max(1, Math.floor((x * (shrinkable - excess)) / shrinkable)));
  }

  const buildRow = (cells: string[], bold: boolean): void => {
    for (const spans of tableRowSpans(cells, widths)) {
      lines.push({ style: 'table', indent: 0, spans: bold ? spans.map((s) => ({ ...s, bold: true })) : spans });
    }
  };

  buildRow(header, true);
  lines.push({ style: 'hr', indent: 0, spans: [{ text: tableRule(widths) }] });
  for (const row of body) buildRow(row, false);
}

/** `sum` helper. */
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** The dim separator rule: mirrors the grid chrome so it aligns exactly. */
function tableRule(widths: number[]): string {
  return '|' + widths.map((wd) => ' ' + '-'.repeat(wd) + ' ').join('|') + '|';
}

/**
 * Word-wrap each cell at its column width, then build aligned rows with
 * grid chrome (`| cell | cell |`). Returns one entry per visual row;
 * every row is exactly sum(widths) + overhead columns wide.
 */
function tableRowSpans(cells: string[], widths: number[]): MdSpan[][] {
  // wrapped[c] = the span-rows cell c occupies after word wrap.
  const wrapped = cells.map((cell, c) => wrapSpans(parseInline(cell), widths[c]));
  const rowCount = Math.max(...wrapped.map((x) => x.length));
  const rows: MdSpan[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const spans: MdSpan[] = [{ text: '| ' }];
    for (let c = 0; c < widths.length; c++) {
      if (c > 0) spans.push({ text: ' | ' });
      const cellSpans = wrapped[c]?.[r];
      if (!cellSpans || cellSpans.length === 0) {
        spans.push({ text: ' '.repeat(widths[c]) });
        continue;
      }
      let used = 0;
      for (const sp of cellSpans) {
        spans.push(sp);
        used += strWidth(sp.text);
      }
      // Right-pad to the column width so cells align (wide chars included).
      spans.push({ text: ' '.repeat(Math.max(0, widths[c] - used)) });
    }
    spans.push({ text: ' |' });
    rows.push(spans);
  }
  return rows;
}
