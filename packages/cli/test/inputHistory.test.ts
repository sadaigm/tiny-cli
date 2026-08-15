import { describe, it, expect } from 'vitest';
import {
  InputHistory,
  DEFAULT_HISTORY_LIMIT,
  searchHistory,
} from '../src/tui/utils/inputHistory.js';

/**
 * Unit tests for the ↑/↓ input-history cursor.
 *
 * This is the shell-style recall in the prompt line: Enter records the
 * line, ↑ walks backwards, ↓ walks forwards, and edits made while
 * browsing are preserved as a draft.
 */
describe('InputHistory', () => {
  it('recalls entries backwards with ↑ and forwards with ↓', () => {
    const h = new InputHistory();
    h.push('first');
    h.push('second');
    h.push('third');

    expect(h.move(-1)).toBe('third');
    expect(h.move(-1)).toBe('second');
    expect(h.move(-1)).toBe('first');
    // Already at the oldest — further ↑ is a no-op.
    expect(h.move(-1)).toBeNull();
    expect(h.move(1)).toBe('second');
    expect(h.move(1)).toBe('third');
    // ↓ past the newest entry returns to the present (restores the draft,
    // empty here); only then is a further ↓ a no-op.
    expect(h.move(1)).toBe('');
    expect(h.move(1)).toBeNull();
  });

  it('returns the most recent entry on the first ↑ after a submit', () => {
    const h = new InputHistory();
    h.push('only line');
    expect(h.current()).toBe(''); // at the present, empty draft
    expect(h.move(-1)).toBe('only line');
  });

  it('preserves the draft typed before browsing away', () => {
    const h = new InputHistory();
    h.push('recorded');
    h.saveDraft('half-typed thought');
    expect(h.move(-1)).toBe('recorded');
    // ↓ returns to the present and restores the draft untouched.
    expect(h.move(1)).toBe('half-typed thought');
    expect(h.current()).toBe('half-typed thought');
  });

  it('collapses consecutive duplicate submissions', () => {
    const h = new InputHistory();
    h.push('same');
    h.push('same');
    h.push('same');
    expect(h.length).toBe(1);
    expect(h.move(-1)).toBe('same');
    expect(h.move(-1)).toBeNull();
  });

  it('keeps non-consecutive duplicates (first ↑ lands on the newer one)', () => {
    const h = new InputHistory();
    h.push('alpha');
    h.push('beta');
    h.push('alpha');
    expect(h.length).toBe(3);
    expect(h.move(-1)).toBe('alpha'); // newest
    expect(h.move(-1)).toBe('beta');
    expect(h.move(-1)).toBe('alpha'); // oldest
  });

  it('rejects empty and whitespace-only submissions', () => {
    const h = new InputHistory();
    expect(h.push('')).toBe(false);
    expect(h.push('   ')).toBe(false);
    expect(h.isEmpty).toBe(true);
    expect(h.move(-1)).toBeNull();
  });

  it('trims submissions before recording', () => {
    const h = new InputHistory();
    h.push('  padded  ');
    expect(h.move(-1)).toBe('padded');
  });

  it('resets the cursor to the present on push (next ↑ recalls the new line)', () => {
    const h = new InputHistory();
    h.push('older');
    h.move(-1); // browsing
    h.push('newer');
    expect(h.atPresent).toBe(true);
    expect(h.move(-1)).toBe('newer');
  });

  it('caps the ring at the configured limit, dropping the oldest', () => {
    const h = new InputHistory(3);
    h.push('one');
    h.push('two');
    h.push('three');
    h.push('four');
    expect(h.length).toBe(3);
    expect(h.toArray()).toEqual(['two', 'three', 'four']);
    // ↑ walks only over the surviving entries.
    expect(h.move(-1)).toBe('four');
    expect(h.move(-1)).toBe('three');
    expect(h.move(-1)).toBe('two');
    expect(h.move(-1)).toBeNull();
  });

  it('uses the default limit when none is given', () => {
    expect(DEFAULT_HISTORY_LIMIT).toBeGreaterThan(0);
    const h = new InputHistory();
    for (let i = 0; i < DEFAULT_HISTORY_LIMIT + 5; i++) h.push(`line-${i}`);
    expect(h.length).toBe(DEFAULT_HISTORY_LIMIT);
    expect(h.move(-1)).toBe(`line-${DEFAULT_HISTORY_LIMIT + 4}`);
  });

  it('clear() empties everything and returns to the present', () => {
    const h = new InputHistory();
    h.push('a');
    h.push('b');
    h.move(-1);
    h.clear();
    expect(h.isEmpty).toBe(true);
    expect(h.atPresent).toBe(true);
    expect(h.current()).toBe('');
    expect(h.move(-1)).toBeNull();
  });

  it('resetToPresent() restores the draft from anywhere', () => {
    const h = new InputHistory();
    h.push('recorded');
    h.saveDraft('my draft');
    h.move(-1);
    expect(h.current()).toBe('recorded');
    expect(h.resetToPresent()).toBe('my draft');
  });
});

/**
 * Unit tests for Ctrl+R reverse-i-search matching.
 *
 * `searchHistory` walks entries newest-first and returns the match at
 * `offset` (0 = newest match); each further Ctrl+R increments it.
 */
describe('searchHistory', () => {
  const entries = ['run tests', 'fix bug', 'run build', 'ship it'];

  it('finds the newest matching entry first', () => {
    const result = searchHistory(entries, 'run');
    expect(result?.entry).toBe('run build');
    expect(result?.matchNumber).toBe(1);
    expect(result?.matchCount).toBe(2);
  });

  it('steps to older matches as offset grows (repeated Ctrl+R)', () => {
    expect(searchHistory(entries, 'run', 0)?.entry).toBe('run build');
    expect(searchHistory(entries, 'run', 1)?.entry).toBe('run tests');
    // Offset clamps at the oldest match — further Ctrl+R is a no-op.
    expect(searchHistory(entries, 'run', 2)?.entry).toBe('run tests');
    expect(searchHistory(entries, 'run', 99)?.matchNumber).toBe(2);
  });

  it('matches case-insensitively', () => {
    expect(searchHistory(entries, 'FIX')?.entry).toBe('fix bug');
    expect(searchHistory(['Run Tests'], 'run t')?.entry).toBe('Run Tests');
  });

  it('matches substrings anywhere in the entry', () => {
    expect(searchHistory(entries, 'bug')?.entry).toBe('fix bug');
    expect(searchHistory(entries, 'it')?.entry).toBe('ship it');
  });

  it('returns null for no matches and empty queries', () => {
    expect(searchHistory(entries, 'deploy')).toBeNull();
    expect(searchHistory(entries, '')).toBeNull();
  });

  it('reports index into the oldest-first list', () => {
    expect(searchHistory(entries, 'ship').index).toBe(3);
    expect(searchHistory(entries, 'run', 1).index).toBe(0);
  });

  it('handles a single match (offset beyond 0 clamps to it)', () => {
    const only = searchHistory(entries, 'ship', 5);
    expect(only?.entry).toBe('ship it');
    expect(only?.matchNumber).toBe(1);
    expect(only?.matchCount).toBe(1);
  });
});
