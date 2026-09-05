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

/** Types + helpers live in ./markdown/*; this file keeps the block-level
 *  parser and re-exports the public surface (see markdown/ for the rest). */
import type { MdSpan, MdLineStyle, MdLine } from './markdown/types.js';
import { strWidth } from './markdown/width.js';
import { parseInline } from './markdown/inline.js';
import { hardChunks, wrapSpans } from './markdown/wrap.js';
import { isPipeRow, isDelimiterRow, splitTableRow, emitTable } from './markdown/tables.js';

export type { MdSpan, MdLineStyle, MdLine } from './markdown/types.js';

/** Indent (in columns) added to fenced-code content. */
const CODE_INDENT = 2;

/** Indent (in columns) added to blockquote content. */
const QUOTE_INDENT = 1;

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
