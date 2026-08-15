import { describe, it, expect } from 'vitest';
import { verticalMoveOffset } from '../src/tui/utils/lineMotion.js';

describe('verticalMoveOffset', () => {
  const draft = 'first line\nsecond line\nthird';

  it('moves down preserving the column', () => {
    expect(verticalMoveOffset(draft, 3, 1)).toBe('first line\n'.length + 3);
  });

  it('moves up preserving the column', () => {
    const onThird = 'first line\nsecond line\n'.length + 2;
    expect(verticalMoveOffset(draft, onThird, -1)).toBe('first line\n'.length + 2);
  });

  it('clamps the column to a shorter target line', () => {
    const onSecond = 'first line\n'.length + 10; // col 10, past "third"'s length? no — third is 5
    expect(verticalMoveOffset(draft, onSecond, 1)).toBe('first line\nsecond line\n'.length + 5);
  });

  it('clamps when moving up into a shorter line', () => {
    const onThird = 'first line\nsecond line\n'.length + 5; // col 5 > "third".length? equal
    // From col 5 on 'third' up to 'second line' (len 11): col preserved.
    expect(verticalMoveOffset(draft, onThird, -1)).toBe('first line\n'.length + 5);
  });

  it('returns null above the first line', () => {
    expect(verticalMoveOffset(draft, 2, -1)).toBeNull();
  });

  it('returns null below the last line', () => {
    const end = draft.length;
    expect(verticalMoveOffset(draft, end, 1)).toBeNull();
  });

  it('returns null for single-line text (history owns the arrows)', () => {
    expect(verticalMoveOffset('only line', 3, -1)).toBeNull();
    expect(verticalMoveOffset('only line', 3, 1)).toBeNull();
    expect(verticalMoveOffset('', 0, 1)).toBeNull();
  });

  it('treats a cursor at a line end as belonging to that line', () => {
    // Cursor at end of line 0 (after 'first line', before \n): col 10.
    expect(verticalMoveOffset(draft, 'first line'.length, 1)).toBe(
      'first line\n'.length + Math.min(10, 'second line'.length),
    );
  });

  it('moves to the start offset when target line is empty', () => {
    const two = 'a\n\nb';
    expect(verticalMoveOffset(two, 1, 1)).toBe(2); // into the empty middle line
    expect(verticalMoveOffset(two, 2, 1)).toBe(3); // out of it onto 'b'
  });

  it('handles a trailing newline (cursor on the empty last line)', () => {
    const trailing = 'one\ntwo\n';
    const atEnd = trailing.length;
    // Empty last line → col 0, so ↑ lands at the start of 'two'.
    expect(verticalMoveOffset(trailing, atEnd, -1)).toBe('one\n'.length);
  });
});
