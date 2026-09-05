import type { MdSpan } from './types.js';

/** Characters whose backslash escape collapses to the literal char. */
const ESCAPABLE = '\\*_`[]';

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
export function parseInline(text: string): MdSpan[] {
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
