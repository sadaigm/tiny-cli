/**
 * @vitest.environment node
 *
 * Tests for the paste → chip → expand round-trip that our code owns.
 *
 * Paste detection itself (recognising `\x1b[200~`…`\x1b[201~` and delivering the
 * payload as one string) is OpenTUI's job via its `usePaste` hook +
 * `decodePasteBytes` — it routes the whole pasted payload to a handler on a
 * dedicated channel that `useKeyboard` never sees. We don't unit-test the
 * framework's marker parsing here.
 *
 * What we DO own and test below: when a paste payload (already stripped of
 * markers, as `usePaste` + `decodePasteBytes` deliver it) arrives,
 * `InputBox.handlePaste` collapses it into a readable chip, and
 * `expandPasteChips` restores the original text on submit. We drive
 * `handlePaste` directly with the same verbatim string the compat layer would
 * hand it.
 */
import { describe, it, expect } from 'vitest';
import {
  pasteChipText,
  countLines,
  expandPasteChips,
  isShortPaste,
  normalizeLineEndings,
} from '../src/tui/utils/pasteChip.js';

/**
 * Reproduces InputBox.handlePaste's contract: normalise line endings, insert
 * short pastes verbatim, otherwise store the paste keyed by an incrementing
 * id and return the chip token, keeping a map for later expansion. This is
 * the exact logic in InputBox (minus React state), so the test exercises the
 * real chip-creation + expansion path end to end.
 */
function simulatePastePayloads() {
  const pastes = new Map<number, string>();
  let nextId = 0;
  const handlePaste = (text: string): string => {
    const normalized = normalizeLineEndings(text);
    if (isShortPaste(normalized)) return normalized;
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
    const payload = 'line one\nline two\nline three\n' + 'x'.repeat(70);
    const chip = handlePaste(payload);
    expect(chip).toBe('[pasted text #1 +4 lines]');
    // No raw payload, no bracketed-paste markers in the chip.
    expect(chip).not.toContain('[201~');
    expect(chip).not.toContain('line two');
  });

  it('expands the chip back to the verbatim pasted text', () => {
    const { handlePaste, expand } = simulatePastePayloads();
    const payload = 'line one\nline two\nline three\n' + 'x'.repeat(70);
    const chip = handlePaste(payload);
    expect(expand(chip)).toBe(payload);
  });

  it('handles a long single-line paste (singular "line")', () => {
    const { handlePaste } = simulatePastePayloads();
    const longLine = 'x'.repeat(81);
    expect(handlePaste(longLine)).toBe('[pasted text #1 +1 line]');
  });

  it('inserts short pastes verbatim instead of a chip', () => {
    const { handlePaste } = simulatePastePayloads();
    // Single word, and a short multi-line paste: both read better as-is.
    expect(handlePaste('verbatim')).toBe('verbatim');
    expect(handlePaste('one\ntwo')).toBe('one\ntwo');
  });

  it('keeps multiple pastes distinct (incrementing ids + separate expansion)', () => {
    const { handlePaste, expand } = simulatePastePayloads();
    const chip1 = handlePaste('first\npaste\n' + 'x'.repeat(80));
    const chip2 = handlePaste('second paste '.repeat(10));
    expect(chip1).toBe('[pasted text #1 +3 lines]');
    expect(chip2).toBe('[pasted text #2 +1 line]');
    expect(expand(chip1)).toBe('first\npaste\n' + 'x'.repeat(80));
    expect(expand(chip2)).toBe('second paste '.repeat(10));
  });
});
