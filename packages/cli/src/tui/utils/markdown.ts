/**
 * Pure markdown → terminal-line layout for message bodies.
 *
 * A hand-rolled subset renderer (no dependencies): {@link markdownToLines}
 * parses a small markdown dialect and lays it out into {@link MdLine} rows
 * sized to a terminal width. It is the ONLY source of truth for both
 * rendering (via {@link ../components/MarkdownBody}) and line counting
 * (MessageLog's `estimateLines` / `renderedBodyLines`) — two separate
 * implementations of this layout would break the scroll viewport math.
 *
 * Purity rules:
 * - No theme, no React, no globals — output depends only on (md, width).
 * - Anything unrecognised renders as plain text; content is never eaten.
 * - Every emitted line satisfies `indent + visible text ≤ width`, so Ink
 *   never soft-wraps a row the layout already accounted for.
 *
 * Supported subset:
 * - ATX headings `#`…`######`
 * - Bold `**x**` / `__x__`, italic `*x*` / `_x_`, strike `~~x~~`,
 *   inline code `` `x` `` (no nested parsing inside code spans)
 * - Fenced code blocks ``` … ``` (content verbatim, hard-chunked)
 * - Unordered `-` / `*` / `+` and ordered `1.` lists, nesting by 2-space
 *   marker indent, item text wrapped with a hanging indent
 * - Blockquotes `>` (dimmed by the renderer)
 * - Horizontal rules `---` / `***` / `___` alone on a line
 * - GFM pipe tables: pipe row + delimiter row (`| --- | :--: |`);
 *   aligned grid with per-column word wrap (see {@link emitTable})
 * - Links `[text](url)` → span with `href`; raw URLs are left for
 *   `splitLinks` in the renderer
 * - Escapes `\*` `\_` `` \` `` `\\` `\[` `\]` → literal char
 * - Unterminated inline markers render literally (streaming-safe: the
 *   pure function re-runs on every delta and the marker "closes" later)
 */

/** One styled run of text inside a line. */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Set on `[text](url)` link spans; the renderer underlines them. */
  href?: string;
}

/** Visual style class of a laid-out line. */
export type MdLineStyle = 'text' | 'heading' | 'code' | 'quote' | 'bullet' | 'table' | 'hr';

/** One terminal row of laid-out markdown. */
export interface MdLine {
  style: MdLineStyle;
  /** Extra columns beyond the body indent (nested lists, code fence, quote). */
  indent: number;
  /** Styled runs; empty array for blank spacer lines (and hr markers). */
  spans: MdSpan[];
}

/** Indent (in columns) added to fenced-code content. */
const CODE_INDENT = 2;

/** Indent (in columns) added to blockquote content. */
const QUOTE_INDENT = 1;

/** Characters whose backslash escape collapses to the literal char. */
const ESCAPABLE = '\\*_`[]';

// Block-level detectors. Fence detection runs first (inside a fence nothing
// else is considered); leading blanks are capped at 3 like CommonMark.
const FENCE_OPEN = /^ {0,3}```/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const HEADING = /^(#{1,6})(?:\s+(.*))?$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Parse + lay out markdown into terminal lines. The ONLY source of truth
 * for both rendering and line counting. Pure: no theme, no React.
 *
 * Never throws: on an internal error the markdown is laid out as plain
 * wrapped text instead (stderr gets the stack) so the app keeps running.
 *
 * @param md - Raw markdown source (may be a streaming partial).
 * @param width - Usable body width in columns (the renderer adds its own
 *   left indent on top of each line's `indent`).
 */
export function markdownToLines(md: string, width: number): MdLine[] {
  try {
    return markdownToLinesImpl(md, width);
  } catch (err) {
    console.error('[markdown] layout failed, falling back to plain text:', err);
    const w = Math.max(1, width);
    const lines: MdLine[] = [];
    for (const raw of md.split(/\r?\n/)) {
      for (const spans of wrapSpans(parseInline(raw), w)) {
        lines.push({ style: 'text', indent: 0, spans });
      }
    }
    return lines;
  }
}

/** The real parser/layout — see {@link markdownToLines}. */
function markdownToLinesImpl(md: string, width: number): MdLine[] {
  if (md === '') return [];
  const w = Math.max(1, width);
  const lines: MdLine[] = [];
  let inFence = false;
  const src = md.split(/\r?\n/);

  for (let li = 0; li < src.length; li++) {
    const raw = src[li];
    // --- Fenced code: content verbatim, no inline parsing, hard-chunked ---
    if (inFence) {
      if (FENCE_CLOSE.test(raw)) {
        inFence = false;
        continue;
      }
      // Clamp the fence indent at narrow widths so indent + content ≤ width.
      const codeIndent = Math.min(CODE_INDENT, Math.max(0, w - 1));
      for (const chunk of hardChunks(raw, Math.max(1, w - codeIndent))) {
        lines.push({
          style: 'code',
          indent: codeIndent,
          spans: chunk === '' ? [] : [{ text: chunk }],
        });
      }
      continue;
    }
    if (FENCE_OPEN.test(raw)) {
      inFence = true; // info string (e.g. ```ts) is not rendered
      continue;
    }

    const line = raw.trim();
    if (line === '') {
      lines.push({ style: 'text', indent: 0, spans: [] }); // blank spacer
      continue;
    }

    // --- Horizontal rule: dashes drawn at layout time so the renderer
    //     stays width-free; the line still counts as exactly one row. ---
    if (HR.test(line)) {
      lines.push({ style: 'hr', indent: 0, spans: [{ text: '─'.repeat(w) }] });
      continue;
    }

    // --- ATX heading ---
    const heading = HEADING.exec(line);
    if (heading) {
      for (const spans of wrapSpans(parseInline(heading[2] ?? ''), w)) {
        lines.push({ style: 'heading', indent: 0, spans });
      }
      continue;
    }

    // --- Blockquote ---
    const quote = QUOTE.exec(line);
    if (quote) {
      const quoteIndent = Math.min(QUOTE_INDENT, Math.max(0, w - 1));
      for (const spans of wrapSpans(parseInline(quote[1] ?? ''), Math.max(1, w - quoteIndent))) {
        lines.push({ style: 'quote', indent: quoteIndent, spans });
      }
      continue;
    }

    // --- List item (leading-space count on the raw line drives nesting) ---
    const item = LIST.exec(raw);
    if (item) {
      const level = Math.floor(item[1].length / 2);
      const indent = Math.min(level * 2, Math.max(0, w - 1));
      const marker = /[-*+]/.test(item[2]) ? '• ' : `${item[2]} `;
      const budget = Math.max(1, w - indent - marker.length);
      const wrapped = wrapSpans(parseInline(item[3]), budget);
      wrapped.forEach((spans, idx) => {
        if (idx === 0) {
          lines.push({ style: 'bullet', indent, spans: [{ text: marker }, ...spans] });
        } else {
          // Hanging indent: continuation aligns under the item text.
          lines.push({ style: 'bullet', indent: indent + marker.length, spans });
        }
      });
      continue;
    }

    // --- GFM pipe table: current line is a pipe row and the next is a
    //     delimiter row. Emit the whole table; continue after its rows. ---
    if (li + 1 < src.length && isPipeRow(line) && isDelimiterRow(src[li + 1].trim())) {
      let end = li + 2;
      while (end < src.length && isPipeRow(src[end].trim())) end++;
      emitTable(lines, src.slice(li + 2, end), splitTableRow(line), w);
      li = end - 1; // `continue` consumes through the last table row
      continue;
    }

    // --- Paragraph: word-wrapped at the full body width ---
    for (const spans of wrapSpans(parseInline(line), w)) {
      lines.push({ style: 'text', indent: 0, spans });
    }
  }
  return lines;
}

// ─── GFM cell width accounting (wide chars occupy 2 columns) ───────────

/** Ranges of code points that render as 2 terminal columns (CJK, emoji). */
const WIDE_CP = /[\u1100-\u115F\u2329-\u232A\u231A-\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F251}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7EB}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;

/** Terminal columns the string occupies (wide chars count as 2). */
function strWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += WIDE_CP.test(ch) ? 2 : 1;
  }
  return width;
}

// ─── GFM pipe tables ───────────────────────────────────────────────────

/** Matches a GFM delimiter cell: `---`, `---:`, `:--`, `:--:` etc. */
const DELIMITER_CELL = /^:?-+:?$/;

/** True when the line is a table row candidate (pipe-delimited cells). */
function isPipeRow(line: string): boolean {
  return line.includes('|') && line.trim() !== '';
}

/** True when the line is a table delimiter row. */
function isDelimiterRow(line: string): boolean {
  if (!isPipeRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL.test(c));
}

/** Split a `| a | b |` row into trimmed cell texts (outer pipes optional). */
function splitTableRow(line: string): string[] {
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
function emitTable(lines: MdLine[], bodyRows: string[], header: string[], w: number): void {
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

// ─── Inline parsing ────────────────────────────────────────────────────

/** Opening `_` emphasis must sit at a word boundary (protects snake_case). */
function isLeftFlankOk(text: string, i: number): boolean {
  return i === 0 || /[\s([{"']/.test(text[i - 1]);
}

/** Closing `_` emphasis must sit at a word boundary (protects snake_case). */
function isRightFlankOk(text: string, after: number): boolean {
  return after >= text.length || /[\s)\]}"'.,;:!?]/.test(text[after]);
}

/**
 * Parse inline markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
 * `[text](url)`, backslash escapes) into styled spans.
 *
 * Unterminated markers are emitted literally — streaming-safe. Code spans
 * suppress nested parsing.
 */
function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain !== '') {
      spans.push({ text: plain });
      plain = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    // Backslash escape → literal char, marker dropped.
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code: content is verbatim (no nested emphasis).
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        spans.push({ text: text.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
    }

    // Bold: **x** / __x__ (with word-boundary flanking for underscores).
    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const close = text.indexOf(text.slice(i, i + 2), i + 2);
      if (close > i + 2 && (c === '*' || (isLeftFlankOk(text, i) && isRightFlankOk(text, close + 2)))) {
        flush();
        spans.push({ text: text.slice(i + 2, close), bold: true });
        i = close + 2;
        continue;
      }
      // Unterminated (or not emphasis): render the marker literally.
      plain += c + c;
      i += 2;
      continue;
    }

    // Italic: *x* / _x_ (with word-boundary flanking for underscores).
    if (c === '*' || c === '_') {
      const close = text.indexOf(c, i + 1);
      const content = close > i + 1 ? text.slice(i + 1, close) : '';
      const flanked = c === '*' || (isLeftFlankOk(text, i) && isRightFlankOk(text, close + 1));
      if (close > i + 1 && text[close + 1] !== c && flanked && !content.startsWith(' ') && !content.endsWith(' ')) {
        flush();
        spans.push({ text: content, italic: true });
        i = close + 1;
        continue;
      }
      plain += c;
      i += 1;
      continue;
    }

    // Strikethrough: ~~x~~
    if (c === '~' && text[i + 1] === '~') {
      const close = text.indexOf('~~', i + 2);
      if (close > i + 2) {
        flush();
        spans.push({ text: text.slice(i + 2, close), strike: true });
        i = close + 2;
        continue;
      }
      plain += '~~';
      i += 2;
      continue;
    }

    // Link: [text](url) — text kept, href attached for underlining.
    if (c === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        const href = text.slice(closeBracket + 2, closeParen);
        if (closeParen !== -1 && href !== '' && !href.includes(' ')) {
          flush();
          spans.push({ text: text.slice(i + 1, closeBracket), href });
          i = closeParen + 1;
          continue;
        }
      }
    }

    plain += c;
    i += 1;
  }
  flush();
  return spans;
}

// ─── Word wrapping ─────────────────────────────────────────────────────

/** True when two spans carry identical styling (for run merging). */
function sameStyle(a: MdSpan, b: MdSpan): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.strike === !!b.strike &&
    !!a.code === !!b.code &&
    a.href === b.href
  );
}

/** Split `text` into fixed-width chunks (used for verbatim code lines). */
function hardChunks(text: string, width: number): string[] {
  if (text === '') return [''];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += width) chunks.push(text.slice(i, i + width));
  return chunks;
}

/**
 * Word-wrap a span stream into lines of at most `width` columns.
 *
 * Breaks on whitespace (never mid-word while a space is available); a word
 * longer than the whole width is hard-chunked. Whitespace at a break point
 * is dropped, so every emitted line is guaranteed to fit.
 *
 * @returns At least one line (possibly with no spans).
 */
function wrapSpans(spans: MdSpan[], width: number): MdSpan[][] {
  const w = Math.max(1, width);

  // Flatten spans into word/space atoms, each carrying its span's style.
  const atoms: Array<{ text: string; style: MdSpan; space: boolean }> = [];
  for (const span of spans) {
    for (const part of span.text.split(/(\s+)/)) {
      if (part === '') continue;
      atoms.push({ text: part, style: span, space: /^\s+$/.test(part) });
    }
  }

  const lines: MdSpan[][] = [];
  let cur: MdSpan[] = [];
  let curLen = 0;
  let pending: Array<{ text: string; style: MdSpan }> = [];

  const flush = (): void => {
    lines.push(cur);
    cur = [];
    curLen = 0;
    pending = [];
  };
  const push = (text: string, style: MdSpan): void => {
    const last = cur[cur.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else cur.push({ ...style, text });
    curLen += text.length;
  };
  const pushWord = (atom: { text: string; style: MdSpan }): void => {
    if (atom.text.length <= w) {
      if (curLen > 0 && curLen + atom.text.length > w) flush();
      push(atom.text, atom.style);
      return;
    }
    // Word longer than the whole line: it can never share a line, so close
    // the current line and chunk the word from column 0.
    let rest = atom.text;
    if (curLen > 0) flush();
    while (rest.length > 0) {
      const avail = w - curLen;
      if (avail <= 0) {
        flush();
        continue;
      }
      push(rest.slice(0, avail), atom.style);
      rest = rest.slice(avail);
      if (rest.length > 0) flush();
    }
  };

  for (const atom of atoms) {
    if (atom.space) {
      if (curLen === 0) continue; // no leading spaces on a fresh line
      pending.push(atom);
      continue;
    }
    if (pending.length > 0) {
      const gap = pending.reduce((sum, p) => sum + p.text.length, 0);
      if (curLen + gap + atom.text.length <= w) {
        pending.forEach((p) => push(p.text, p.style));
      } else {
        // The word doesn't fit after the space: break AT the space. The
        // space itself is dropped (no trailing whitespace), but the line
        // must break — silently joining the words would lose the gap.
        flush();
      }
      pending = [];
    }
    pushWord(atom);
  }  if (cur.length > 0 || lines.length === 0) lines.push(cur);
  return lines;
}
