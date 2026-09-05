import type { MdSpan } from './types.js';

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
export function hardChunks(text: string, width: number): string[] {
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
export function wrapSpans(spans: MdSpan[], width: number): MdSpan[][] {
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
