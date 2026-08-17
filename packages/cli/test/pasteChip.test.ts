import { describe, it, expect } from 'vitest';
import {
  pasteChipText,
  countLines,
  expandPasteChips,
  chipAt,
  normalizeLineEndings,
} from '../src/tui/utils/pasteChip.js';

describe('normalizeLineEndings', () => {
  it('converts bare carriage returns to newlines', () => {
    // A bare \r overstrikes when printed (cursor returns to column 0 without a
    // line feed), so pastes containing it look scrambled. Normalising to \n
    // makes the content display as real separate lines.
    expect(normalizeLineEndings('flowchart TD\r    MAIN[]')).toBe('flowchart TD\n    MAIN[]');
  });

  it('converts CRLF to a single newline', () => {
    expect(normalizeLineEndings('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('handles mixed line endings', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('leaves already-normal text unchanged', () => {
    expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
  });
});

describe('countLines', () => {
  it('counts a single line as 1', () => {
    expect(countLines('hello')).toBe(1);
  });

  it('counts N segments separated by newlines', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('counts carriage-return and CRLF line endings (Windows / terminal paste)', () => {
    expect(countLines('a\rb\rc')).toBe(3);
    expect(countLines('a\r\nb\r\nc')).toBe(3);
    expect(countLines('a\rb\nc')).toBe(3); // mixed
  });

  it('does not count a trailing newline as an extra line', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb\n\n\n')).toBe(2);
  });

  it('treats empty string as 1 line', () => {
    expect(countLines('')).toBe(1);
  });
});

describe('pasteChipText', () => {
  it('uses singular "line" for a single-line paste', () => {
    expect(pasteChipText(1, 1)).toBe('[pasted text #1 +1 line]');
  });

  it('uses plural "lines" for multi-line pastes', () => {
    expect(pasteChipText(2, 3)).toBe('[pasted text #2 +3 lines]');
  });

  it('floors a 0-line count to 1 so the label stays sensible', () => {
    expect(pasteChipText(5, 0)).toBe('[pasted text #5 +1 line]');
  });

  it('embeds the chip id verbatim', () => {
    expect(pasteChipText(42, 10)).toBe('[pasted text #42 +10 lines]');
  });
});

describe('chipAt', () => {
  const text = `before[pasted text #1 +3 lines]after`;

  it('finds a chip when the cursor is at its first char', () => {
    expect(chipAt(text, text.indexOf('['))).toEqual({
      start: text.indexOf('['),
      end: text.indexOf(']') + 1,
    });
  });

  it('finds a chip when the cursor is just past its closing bracket', () => {
    const end = text.indexOf(']') + 1;
    expect(chipAt(text, end)).toEqual({ start: text.indexOf('['), end });
  });

  it('finds a chip when the cursor is in its middle', () => {
    const mid = text.indexOf('+3');
    expect(chipAt(text, mid)).not.toBeNull();
  });

  it('returns null when the cursor is on ordinary text', () => {
    expect(chipAt(text, 2)).toBeNull();
    expect(chipAt(text, text.length)).toBeNull();
  });

  it('matches the second chip when two are present', () => {
    const two = '[pasted text #1 +1 line] [pasted text #2 +4 lines]';
    const secondIdx = two.indexOf('[pasted text #2');
    expect(chipAt(two, secondIdx + 3)).toEqual({
      start: secondIdx,
      end: two.length,
    });
  });
});

describe('expandPasteChips', () => {
  it('replaces a chip with its stored raw text', () => {
    const pastes = new Map([[1, 'line one\nline two']]);
    const input = `comment [pasted text #1 +2 lines] tail`;
    expect(expandPasteChips(input, pastes)).toBe(
      'comment line one\nline two tail',
    );
  });

  it('replaces multiple chips, preserving order', () => {
    const pastes = new Map([
      [1, 'AAA'],
      [2, 'BBB'],
    ]);
    const input = '[pasted text #1 +1 line] mid [pasted text #2 +1 lines]';
    expect(expandPasteChips(input, pastes)).toBe('AAA mid BBB');
  });

  it('leaves chips with unknown ids untouched (defensive)', () => {
    const pastes = new Map([[1, 'x']]);
    expect(expandPasteChips('[pasted text #99 +1 line]', pastes)).toBe(
      '[pasted text #99 +1 line]',
    );
  });

  it('returns the string unchanged when there are no chips', () => {
    const pastes = new Map([[1, 'x']]);
    expect(expandPasteChips('just plain text', pastes)).toBe('just plain text');
  });
});
