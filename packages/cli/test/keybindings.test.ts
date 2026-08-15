import { describe, it, expect } from 'vitest';
import { parseBinding, matchesBinding, DEFAULT_BINDINGS } from '../src/tui/keybindings.js';

describe('parseBinding', () => {
  it('parses ctrl combos case-insensitively', () => {
    expect(parseBinding('ctrl+p')).toEqual({ ctrl: true, alt: false, key: 'p' });
    expect(parseBinding('Ctrl+P')).toEqual({ ctrl: true, alt: false, key: 'p' });
    expect(parseBinding('CTRL+R')).toEqual({ ctrl: true, alt: false, key: 'r' });
  });

  it('parses alt combos and named keys', () => {
    expect(parseBinding('alt+b')).toEqual({ ctrl: false, alt: true, key: 'b' });
    expect(parseBinding('escape')).toEqual({ ctrl: false, alt: false, key: 'escape' });
    expect(parseBinding('pageup')).toEqual({ ctrl: false, alt: false, key: 'pageup' });
  });

  it('parses single letters as bare bindings', () => {
    expect(parseBinding('y')).toEqual({ ctrl: false, alt: false, key: 'y' });
  });

  it('rejects malformed specs', () => {
    expect(parseBinding('')).toBeNull();
    expect(parseBinding('ctrl')).toBeNull();
    expect(parseBinding('ctrl+shift+p')).toBeNull();
    expect(parseBinding('meta+p')).toBeNull();
    expect(parseBinding('notakey')).toBeNull();
    expect(parseBinding('ctrl+1')).toBeNull();
    expect(parseBinding('ctrl++')).toBeNull();
  });
});

describe('matchesBinding', () => {
  const ctrlP = { ctrl: true, alt: false, key: 'p' };
  const esc = { ctrl: false, alt: false, key: 'escape' };
  const bareY = { ctrl: false, alt: false, key: 'y' };

  it('matches a ctrl key event', () => {
    expect(matchesBinding('p', { ctrl: true }, ctrlP)).toBe(true);
    expect(matchesBinding('p', {}, ctrlP)).toBe(false);
    expect(matchesBinding('q', { ctrl: true }, ctrlP)).toBe(false);
  });

  it('matches escape', () => {
    expect(matchesBinding('', { escape: true }, esc)).toBe(true);
    expect(matchesBinding('', {}, esc)).toBe(false);
  });

  it('a bare letter must not fire with ctrl or meta held', () => {
    expect(matchesBinding('y', {}, bareY)).toBe(true);
    expect(matchesBinding('y', { ctrl: true }, bareY)).toBe(false);
    expect(matchesBinding('y', { meta: true }, bareY)).toBe(false);
  });

  it('returns false for null or undefined bindings', () => {
    expect(matchesBinding('p', { ctrl: true }, null)).toBe(false);
    expect(matchesBinding('p', { ctrl: true }, undefined)).toBe(false);
  });

  it('arrow-key bindings match via the named map', () => {
    const up = { ctrl: false, alt: false, key: 'up' };
    expect(matchesBinding('', { upArrow: true }, up)).toBe(true);
    expect(matchesBinding('', { downArrow: true }, up)).toBe(false);
  });
});

describe('DEFAULT_BINDINGS', () => {
  it('covers every action with a parseable spec', () => {
    for (const spec of Object.values(DEFAULT_BINDINGS)) {
      expect(parseBinding(spec)).not.toBeNull();
    }
  });
});
