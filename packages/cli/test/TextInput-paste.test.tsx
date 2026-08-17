/**
 * @vitest.environment node
 *
 * Tests for the paste → chip → expand round-trip that our code owns.
 *
 * Paste detection itself (recognising `\x1b[200~`…`\x1b[201~` and delivering the
 * payload as one string) is now Ink 7's job via its `usePaste` hook — it routes
 * the whole pasted string to a handler on a dedicated channel that `useInput`
 * never sees, which is exactly what stops the old `[201~` marker leak. We don't
 * unit-test the framework's marker parsing here.
 *
 * What we DO own and test below: when a paste payload (already stripped of
 * markers, as `usePaste` delivers it) arrives, `InputBox.handlePaste` collapses
 * it into a readable chip, and `expandPasteChips` restores the original text on
 * submit. We drive `handlePaste` directly with the same verbatim string Ink's
 * `usePaste` would hand it.
 *
 * Why not an ink-testing-library `stdin.write` test? ink-testing-library@4 (the
 * latest release) uses a fake stdin that doesn't drive Ink 7's
 * `'readable'`-based input loop, so `useInput`/`usePaste` never fire under it.
 * Revisit once ink-testing-library ships Ink 7 support.
 */
import { describe, it, expect } from 'vitest';
import {
  pasteChipText,
  countLines,
  expandPasteChips,
  normalizeLineEndings,
} from '../src/tui/utils/pasteChip.js';

/**
 * Reproduces InputBox.handlePaste's contract: normalise line endings, store the
 * paste keyed by an incrementing id, return the chip token, and keep a map for
 * later expansion. This is the exact logic in InputBox (minus React state), so
 * the test exercises the real chip-creation + expansion path end to end.
 */
function simulatePastePayloads() {
  const pastes = new Map<number, string>();
  let nextId = 0;
  const handlePaste = (text: string): string => {
    const normalized = normalizeLineEndings(text);
    nextId += 1;
    const id = nextId;
    pastes.set(id, normalized);
    return pasteChipText(id, countLines(normalized));
  };
  return {
    handlePaste,
    expand: (chip: string) => expandPasteChips(chip, pastes),
  };
}

describe('paste → chip → expand', () => {
  it('collapses a multi-line paste into a chip and never leaks markers', () => {
    const { handlePaste } = simulatePastePayloads();
    // The payload Ink's usePaste delivers — markers already stripped.
    const chip = handlePaste('line one\nline two\nline three');
    expect(chip).toBe('[pasted text #1 +3 lines]');
    // No raw payload, no bracketed-paste markers in the chip.
    expect(chip).not.toContain('[201~');
    expect(chip).not.toContain('line two');
  });

  it('expands the chip back to the verbatim pasted text', () => {
    const { handlePaste, expand } = simulatePastePayloads();
    const payload = 'line one\nline two\nline three';
    const chip = handlePaste(payload);
    expect(expand(chip)).toBe(payload);
  });

  it('handles a single-line paste (singular "line")', () => {
    const { handlePaste } = simulatePastePayloads();
    expect(handlePaste('just one line')).toBe('[pasted text #1 +1 line]');
  });

  it('keeps multiple pastes distinct (incrementing ids + separate expansion)', () => {
    const { handlePaste, expand } = simulatePastePayloads();
    const chip1 = handlePaste('first\npaste');
    const chip2 = handlePaste('second paste');
    expect(chip1).toBe('[pasted text #1 +2 lines]');
    expect(chip2).toBe('[pasted text #2 +1 line]');
    expect(expand(chip1)).toBe('first\npaste');
    expect(expand(chip2)).toBe('second paste');
  });
});
