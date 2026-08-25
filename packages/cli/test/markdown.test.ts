import { describe, it, expect } from 'vitest';
import { markdownToLines, type MdLine, type MdSpan } from '../src/tui/utils/markdown.js';

/** Flatten a laid-out block into its per-line plain text. */
function texts(lines: MdLine[]): string[] {
  return lines.map((l) => l.spans.map((s) => s.text).join(''));
}

/** Extract the first span with a given flag set. */
function spanWith(lines: MdLine[], flag: 'bold' | 'italic' | 'strike' | 'code' | 'href'): MdSpan | undefined {
  for (const line of lines) {
    for (const s of line.spans) {
      if (flag === 'href' ? s.href !== undefined : s[flag]) return s;
    }
  }
  return undefined;
}

describe('markdownToLines — block structure', () => {
  it('returns [] for empty input', () => {
    expect(markdownToLines('', 40)).toEqual([]);
  });

  it('renders blank source lines as empty spacer lines', () => {
    const lines = markdownToLines('a\n\nb', 40);
    expect(lines).toHaveLength(3);
    expect(lines[1].spans).toEqual([]);
    expect(texts(lines)).toEqual(['a', '', 'b']);
  });

  it('renders every ATX heading level as one heading line, markers dropped', () => {
    for (let level = 1; level <= 6; level++) {
      const lines = markdownToLines(`${'#'.repeat(level)} Title`, 40);
      expect(lines).toHaveLength(1);
      expect(lines[0].style).toBe('heading');
      expect(texts(lines)[0]).toBe('Title');
    }
  });

  it('renders --- / *** / ___ alone on a line as an hr', () => {
    for (const marker of ['---', '***', '___']) {
      const lines = markdownToLines(marker, 40);
      expect(lines).toHaveLength(1);
      expect(lines[0].style).toBe('hr');
    }
  });

  it('does not treat --- as hr when embedded in text', () => {
    const lines = markdownToLines('a --- b', 40);
    expect(lines[0].style).toBe('text');
    expect(texts(lines)[0]).toBe('a --- b');
  });

  it('renders blockquotes dim-style with indent 1', () => {
    const lines = markdownToLines('> quoted text', 40);
    expect(lines).toHaveLength(1);
    expect(lines[0].style).toBe('quote');
    expect(lines[0].indent).toBe(1);
    expect(texts(lines)[0]).toBe('quoted text');
  });
});

describe('markdownToLines — fenced code blocks', () => {
  it('renders content verbatim with no inline parsing', () => {
    const md = '```\n**not bold** `x`\n```';
    const lines = markdownToLines(md, 40);
    expect(lines).toHaveLength(1);
    expect(lines[0].style).toBe('code');
    expect(lines[0].indent).toBe(2);
    expect(texts(lines)[0]).toBe('**not bold** `x`');
  });

  it('preserves fence markers inside content when not at line start', () => {
    const md = '```ts\nconst a = `t`;\nindent  ```x\n```';
    const lines = markdownToLines(md, 40);
    expect(texts(lines)).toEqual(['const a = `t`;', 'indent  ```x']);
    expect(lines.every((l) => l.style === 'code')).toBe(true);
  });

  it('hard-chunks long code lines at width (minus indent)', () => {
    const md = '```\n' + 'x'.repeat(50) + '\n```';
    const lines = markdownToLines(md, 30);
    expect(lines).toHaveLength(2);
    expect(texts(lines)).toEqual(['x'.repeat(28), 'x'.repeat(22)]);
  });

  it('keeps blank lines inside a fence as blank code lines', () => {
    const lines = markdownToLines('```\na\n\nb\n```', 40);
    expect(texts(lines)).toEqual(['a', '', 'b']);
    expect(lines[1].style).toBe('code');
  });
});

describe('markdownToLines — lists', () => {
  it('renders unordered markers as • with the text after it', () => {
    for (const marker of ['-', '*', '+']) {
      const lines = markdownToLines(`${marker} item one`, 40);
      expect(lines).toHaveLength(1);
      expect(lines[0].style).toBe('bullet');
      expect(texts(lines)[0]).toBe('• item one');
    }
  });

  it('renders ordered markers as N. with the text after it', () => {
    const lines = markdownToLines('1. first\n2. second', 40);
    expect(texts(lines)).toEqual(['1. first', '2. second']);
    expect(lines[0].spans[0].bold).toBeUndefined();
  });

  it('nests by 2-space marker indent', () => {
    const lines = markdownToLines('- top\n  - nested\n    - deeper', 40);
    expect(lines.map((l) => l.indent)).toEqual([0, 2, 4]);
    expect(texts(lines)).toEqual(['• top', '• nested', '• deeper']);
  });

  it('wraps item text with a hanging indent aligned under the text', () => {
    const lines = markdownToLines('- ' + 'word '.repeat(10), 20);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].indent).toBe(0);
    // Continuation lines align under the item text (after "• ").
    expect(lines[1].indent).toBe(2);
    // No line (indent + text) exceeds the width.
    for (const l of lines) {
      const len = l.indent + l.spans.reduce((sum, s) => sum + s.text.length, 0);
      expect(len).toBeLessThanOrEqual(20);
    }
  });
});

describe('markdownToLines — inline spans', () => {
  it('bold **x** and __x__', () => {
    for (const md of ['**bold**', '__bold__']) {
      const lines = markdownToLines(md, 40);
      expect(texts(lines)[0]).toBe('bold');
      expect(spanWith(lines, 'bold')?.bold).toBe(true);
    }
  });

  it('italic *x* and _x_', () => {
    for (const md of ['*italic*', '_italic_']) {
      const lines = markdownToLines(md, 40);
      expect(texts(lines)[0]).toBe('italic');
      expect(spanWith(lines, 'italic')?.italic).toBe(true);
    }
  });

  it('strike ~~x~~', () => {
    const lines = markdownToLines('~~gone~~', 40);
    expect(texts(lines)[0]).toBe('gone');
    expect(spanWith(lines, 'strike')?.strike).toBe(true);
  });

  it('inline code `x` with no nested parsing inside', () => {
    const lines = markdownToLines('use `foo()` now', 40);
    expect(spanWith(lines, 'code')?.text).toBe('foo()');
    const joined = texts(lines)[0];
    expect(joined).toBe('use foo() now');
  });

  it('bold + italic + code combined in one span run', () => {
    const lines = markdownToLines('**b** and *i* and `c` end', 40);
    const flags = lines[0].spans.map((s) => ({
      b: !!s.bold,
      i: !!s.italic,
      c: !!s.code,
    }));
    expect(flags).toEqual([
      { b: true, i: false, c: false },
      { b: false, i: false, c: false },
      { b: false, i: true, c: false },
      { b: false, i: false, c: false },
      { b: false, i: false, c: true },
      { b: false, i: false, c: false },
    ]);
    expect(texts(lines)[0]).toBe('b and i and c end');
  });

  it('does not treat underscores inside words as emphasis (snake_case)', () => {
    const lines = markdownToLines('call `price_plan_comaparison.md`', 40);
    // The code span keeps its underscores; they must not become italics.
    expect(texts(lines)[0]).toBe('call price_plan_comaparison.md');
    const code = spanWith(lines, 'code');
    expect(code?.code).toBe(true);
    expect(spanWith(lines, 'italic')).toBeUndefined();
  });

  it('link [text](url) keeps text and sets href', () => {
    const lines = markdownToLines('see [docs](https://example.com) now', 40);
    const link = spanWith(lines, 'href');
    expect(link?.text).toBe('docs');
    expect(link?.href).toBe('https://example.com');
    expect(texts(lines)[0]).toBe('see docs now');
  });
});

describe('markdownToLines — escapes and unterminated markers', () => {
  it('renders escaped markers literally, dropping the backslash', () => {
    const lines = markdownToLines('\\*not italic\\* \\_x\\_ \\`c\\` \\[b\\] \\\\slash', 40);
    expect(texts(lines)[0]).toBe('*not italic* _x_ `c` [b] \\slash');
  });

  it('unterminated ** stays literal (streaming-safe)', () => {
    const lines = markdownToLines('started **bold and more', 40);
    expect(texts(lines)[0]).toBe('started **bold and more');
    expect(spanWith(lines, 'bold')).toBeUndefined();
  });

  it('unterminated * stays literal', () => {
    const lines = markdownToLines('half *italic', 40);
    expect(texts(lines)[0]).toBe('half *italic');
  });

  it('unterminated ` stays literal', () => {
    const lines = markdownToLines('code `foo', 40);
    expect(texts(lines)[0]).toBe('code `foo');
  });

  it('unterminated ~~ stays literal', () => {
    const lines = markdownToLines('gone ~~strike', 40);
    expect(texts(lines)[0]).toBe('gone ~~strike');
  });

  it('unterminated [ stays literal', () => {
    const lines = markdownToLines('see [docs', 40);
    expect(texts(lines)[0]).toBe('see [docs');
  });
});

describe('markdownToLines — word wrap', () => {
  it('breaks on spaces, never mid-word while a space is available', () => {
    const lines = markdownToLines('alpha beta gamma delta', 10);
    expect(texts(lines)).toEqual(['alpha beta', 'gamma', 'delta']);
  });

  it('never exceeds the width, including indent', () => {
    const md = ['# Long heading ' + 'word '.repeat(20), '- ' + 'word '.repeat(20), '> quote ' + 'word '.repeat(20), 'para ' + 'word '.repeat(20)].join('\n');
    for (const w of [10, 12, 20, 37]) {
      const lines = markdownToLines(md, w);
      for (const l of lines) {
        const len = l.indent + l.spans.reduce((sum, s) => sum + s.text.length, 0);
        expect(len).toBeLessThanOrEqual(w);
      }
    }
  });

  it('hard-chunks a word longer than the whole width', () => {
    const lines = markdownToLines('x'.repeat(25), 10);
    expect(texts(lines)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('hard-chunks a long word that lands mid-line', () => {
    const lines = markdownToLines('ab ' + 'y'.repeat(15), 10);
    // The oversized word can't share a line, so it starts fresh and chunks.
    expect(texts(lines)).toEqual(['ab', 'y'.repeat(10), 'y'.repeat(5)]);
  });

  it('drops the space at a wrap point (no trailing whitespace)', () => {
    const lines = markdownToLines('aaa bbb', 3);
    expect(texts(lines)).toEqual(['aaa', 'bbb']);
  });

  it('wraps a line of only spaces to a single blank line', () => {
    const lines = markdownToLines('   ', 40);
    expect(lines).toHaveLength(1);
    expect(texts(lines)[0]).toBe('');
  });
});

describe('markdownToLines — regression: bug-report sample', () => {
  it('renders the exact sample from the bug report without raw markers', () => {
    const md = '**File updated** ✅ — `price_plan_comaparison.md`';
    const lines = markdownToLines(md, 80);
    expect(texts(lines)[0]).toBe('File updated ✅ — price_plan_comaparison.md');
    expect(lines[0].spans[0].bold).toBe(true);
    expect(spanWith(lines, 'code')?.code).toBe(true);
  });

  it('renders the bug-report body shapes (list + code + heading) readably', () => {
    const md = [
      '## Summary',
      '',
      'Fixed the **wrap** bug:',
      '',
      '- word wrap breaks on spaces',
      '  - nested item',
      '- `wrapIndent` no longer chunks mid-word',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const lines = markdownToLines(md, 40);
    expect(lines[0].style).toBe('heading');
    expect(texts(lines)).toEqual([
      'Summary',
      '',
      'Fixed the wrap bug:',
      '',
      '• word wrap breaks on spaces',
      '• nested item',
      '• wrapIndent no longer chunks mid-word',
      '',
      'const x = 1;',
    ]);
    expect(lines[8].style).toBe('code');
  });
});

describe('markdownToLines — GFM pipe tables', () => {
  const table = [
    '| Check | Result |',
    '|---|---|',
    '| tsc build | ✅ Clean |',
    '| Tests | 176/176 passed |',
  ].join('\n');

  it('renders a table as an aligned grid with borders', () => {
    const lines = markdownToLines(table, 60);
    expect(lines.every((l) => l.style === 'table' || l.style === 'hr')).toBe(true);
    const t = texts(lines);
    // Header row: | padded | padded |
    expect(t[0]).toBe('| Check     | Result         |');
    expect(t[2]).toBe('| tsc build | ✅ Clean       |');
    expect(t[3]).toBe('| Tests     | 176/176 passed |');
    // Separator between header and body mirrors the grid chrome exactly
    expect(lines[1].style).toBe('hr');
    expect(t[1]).toBe('| --------- | -------------- |');
  });

  it('renders a ragged table (body row wider than header) without crashing', () => {
    const ragged = ['| A |', '|---|', '| 1 | 2 | 3 |'].join('\n');
    const lines = markdownToLines(ragged, 40);
    expect(lines.every((l) => l.style === 'table' || l.style === 'hr')).toBe(true);
    expect(texts(lines)[2]).toBe('| 1 | 2 | 3 |');
  });

  it('bolds the header row', () => {
    const lines = markdownToLines(table, 60);
    expect(lines[0].spans.some((s) => s.bold)).toBe(true);
    expect(lines[2].spans.some((s) => s.bold)).toBe(false);
  });

  it('aligns columns across rows (borders at identical columns, wide chars included)', () => {
    const lines = markdownToLines(table, 60);
    // Walk each rendered row accumulating terminal columns; border pipes
    // must sit at identical column offsets in every row (incl. the hr rule).
    const borderCols = texts(lines).map((row) => {
      const cols: number[] = [];
      let col = 0;
      for (const ch of row) {
        if (ch === '|') cols.push(col);
        // Wide chars advance 2 columns (same ranges the layout pads for).
        col += /[✅❌⭐\u{1F300}-\u{1F64F}]/u.test(ch) ? 2 : 1;
      }
      return cols.join(',');
    });
    expect(new Set(borderCols).size).toBe(1);
    expect(borderCols[0]).toBe('0,12,29');
  });

  it('shrinks columns to fit narrow widths and wraps cells', () => {
    const lines = markdownToLines(table, 20);
    for (const l of lines) {
      const len = l.spans.reduce((sum, s) => sum + s.text.length, 0);
      expect(len).toBeLessThanOrEqual(20);
    }
    // 2 cols × (min width 1 + chrome) always fits 20 cols; cells wrapped
    expect(lines.length).toBeGreaterThan(4);
  });

  it('renders inline styling inside cells (bold/code)', () => {
    const md = [
      '| A | B |',
      '|---|---|',
      '| **bold** | `code` |',
    ].join('\n');
    const lines = markdownToLines(md, 40);
    const boldSpan = lines.flatMap((l) => l.spans).find((s) => s.bold && s.text.includes('bold'));
    expect(boldSpan?.text).toBe('bold');
    const codeSpan = lines.flatMap((l) => l.spans).find((s) => s.code && s.text.includes('code'));
    expect(codeSpan?.text).toBe('code');
  });

  it('does not treat a lone pipe row without delimiter as a table', () => {
    const lines = markdownToLines('| a | b |', 40);
    expect(lines.every((l) => l.style === 'text')).toBe(true);
    expect(texts(lines)).toEqual(['| a | b |']);
  });

  it('escapes pipes inside cells (\\| renders as literal pipe)', () => {
    const md = [
      '| Cmd | Args |',
      '|---|---|',
      '| ls \\| grep | x |',
    ].join('\n');
    const lines = markdownToLines(md, 40);
    const t = texts(lines);
    expect(t[2]).toContain('| ls | grep');
  });

  it('falls back to plain text when even one column cannot fit', () => {
    const lines = markdownToLines(table, 4);
    // Content preserved: every cell word appears in the plain-text render
    // Hard-chunking may split words at width 4 (same as any paragraph),
    // so compare with whitespace stripped: every character must survive.
    const flat = texts(lines).join('').replace(/\s/g, '');
    for (const word of ['Check', 'Result', 'tscbuild', 'Tests', '176/176passed'])
      expect(flat).toContain(word);
    expect(lines.every((l) => l.style === 'text')).toBe(true);
  });
});
