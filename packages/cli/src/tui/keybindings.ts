/**
 * Configurable keybindings for the TUI's global actions.
 *
 * Remaps are loaded from `~/.tiny-cli/keys.json`; unknown actions or
 * malformed keys fall back to the default binding, so a bad file can only
 * fail to change a key, never break input handling.
 *
 * File format (all keys optional):
 *
 *   { "browse": "ctrl+p", "sessionSwitcher": "ctrl+s",
 *     "historySearch": "ctrl+r", "abort": "escape" }
 *
 * Key syntax: any combination of `ctrl+`, `alt+`, `shift+` modifiers plus a
 * base key: a letter, a digit, or a named key (`escape`, `tab`, `f1`…).
 * Case-insensitive; `ctrl+P` == `ctrl+p`.
 *
 * Bindings the terminal/OpenTUI can't deliver (or malformed specs) are
 * logged to tui.log and the action keeps its default binding.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logInfo } from '@tiny-cli/core';

/** The remappable global actions. */
export type BindableAction =
  | 'browse'
  | 'historySearch'
  | 'sessionSwitcher'
  | 'abort'
  | 'yank';

/** Canonical key descriptor: modifiers + base key. */
export interface KeyDescriptor {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-cased base key: a letter, a digit, or a named key like `escape`/`f1`. */
  key: string;
}

/** Default bindings (must match the hard-coded defaults in the components). */
export const DEFAULT_BINDINGS: Record<BindableAction, string> = {
  browse: 'ctrl+p',
  historySearch: 'ctrl+r',
  sessionSwitcher: 'ctrl+s',
  abort: 'escape',
  yank: 'y',
};

/** Project-first (like agents.json): `<cwd>/.tiny-cli/keys.json` wins over the home copy. */
const KEYS_FILE = path.join(os.homedir(), '.tiny-cli', 'keys.json');
const PROJECT_KEYS_FILE = path.join(process.cwd(), '.tiny-cli', 'keys.json');

/** Named keys the compat layer reports on the `key` object. */
const NAMED_KEYS = new Set([
  'escape', 'tab', 'return', 'enter', 'backspace', 'delete',
  'up', 'down', 'left', 'right', 'home', 'end',
  'pageup', 'pagedown', 'space',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/**
 * Read the first file that exists among `candidates`, or null when none
 * do. Used for project-first config lookup (project `.tiny-cli/` beats
 * the home copy).
 */
export function readFirstExisting(...candidates: string[]): string | null {
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Parse a binding string into a descriptor, or null when malformed.
 * Anything not parseable is treated as "not set".
 */
export function parseBinding(spec: string): KeyDescriptor | null {
  const parts = spec.trim().toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;
  const base = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  if (modifiers.size !== parts.length - 1) return null; // duplicate modifier
  for (const m of modifiers) {
    if (m !== 'ctrl' && m !== 'alt' && m !== 'shift') return null;
  }
  const validBase = base.length === 1 ? /[a-z0-9]/.test(base) : NAMED_KEYS.has(base);
  if (!validBase) return null;
  return { ctrl: modifiers.has('ctrl'), alt: modifiers.has('alt'), shift: modifiers.has('shift'), key: base };
}

/**
 * All bindings, parsed. Values are null when unbound or invalid (callers
 * treat null as "action disabled / keep default").
 */
export interface Keybindings {
  bindings: Partial<Record<BindableAction, KeyDescriptor | null>>;
  /** True when a keys.json was found and at least one action parsed. */
  loadedFromFile: boolean;
}

/**
 * Load remaps from `~/.tiny-cli/keys.json`, merged over the defaults.
 * Synchronous — read once at startup, before the first render.
 */
export function loadKeybindings(): Keybindings {
  const result: Keybindings = { bindings: {}, loadedFromFile: false };
  for (const action of Object.keys(DEFAULT_BINDINGS) as BindableAction[]) {
    result.bindings[action] = parseBinding(DEFAULT_BINDINGS[action]);
  }
  const raw = readFirstExisting(PROJECT_KEYS_FILE, KEYS_FILE);
  if (!raw) return result;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<BindableAction, unknown>>;
    for (const action of Object.keys(DEFAULT_BINDINGS) as BindableAction[]) {
      const value = parsed[action];
      if (typeof value !== 'string') continue;
      const parsedBinding = parseBinding(value);
      if (parsedBinding) {
        result.bindings[action] = parsedBinding;
        result.loadedFromFile = true;
      } else {
        // Unparseable spec: keep the default and note it in tui.log — never
        // crash or silently drop the action.
        logInfo(`keys.json: ignoring invalid binding "${value}" for action "${action}" — keeping default "${DEFAULT_BINDINGS[action]}"`);
      }
    }
  } catch (err) {
    // Invalid JSON — defaults stand, note it in tui.log.
    logInfo(`keys.json: parse failed (${(err as Error)?.message ?? err}) — keeping default bindings`);
  }
  return result;
}

/**
 * The active bindings — set once at startup (render.tsx), read anywhere.
 * Mirrors the theme singleton pattern: a value that never changes
 * mid-session shouldn't be a prop threaded through the tree.
 */
let activeBindings: Keybindings = {
  // Default bindings pre-parsed, so components work even before (or without)
  // an explicit setKeybindings() call — render.tsx still installs the
  // user's remaps at startup.
  bindings: Object.fromEntries(
    (Object.keys(DEFAULT_BINDINGS) as BindableAction[]).map((action) => [
      action,
      parseBinding(DEFAULT_BINDINGS[action]),
    ]),
  ),
  loadedFromFile: false,
};

/** Install the active bindings (call once before mounting the TUI). */
export function setKeybindings(kb: Keybindings): void {
  activeBindings = kb;
}

/** The binding descriptor for an action (null when unbound/invalid). */
export function bindingFor(action: BindableAction): KeyDescriptor | null | undefined {
  return activeBindings.bindings[action];
}

/**
 * Whether a raw Ink key event matches a descriptor.
 *
 * @param input  The useInput `input` string (may be '' for pure escape keys).
 * @param key    The useInput `key` object.
 * @param desc   The binding to test against.
 */
export function matchesBinding(
  input: string,
  key: {
    ctrl?: boolean;
    shift?: boolean;
    escape?: boolean;
    return?: boolean;
    tab?: boolean;
    backspace?: boolean;
    delete?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    meta?: boolean;
    /** Raw key name from the compat layer (e.g. 'f1' … 'f12'). */
    name?: string;
  },
  desc: KeyDescriptor | null | undefined,
): boolean {
  if (!desc) return false;
  // ctrl/alt must match exactly: an unmodified binding must not fire while
  // ctrl/alt is held, and vice versa. Shift is only constrained for
  // bindings that use it — OpenTUI stamps shift on some key events (e.g.
  // escape) where requiring shift===false would break the binding.
  const ctrlOk = desc.ctrl === Boolean(key.ctrl);
  const altOk = desc.alt === Boolean(key.meta);
  const shiftOk = !desc.shift || key.shift === true;
  if (desc.ctrl || desc.alt) {
    return ctrlOk && altOk && shiftOk && input.toLowerCase() === desc.key;
  }
  // Named keys (incl. F-keys via the raw name).
  const named: Record<string, boolean | undefined> = {
    escape: key.escape,
    tab: key.tab,
    return: key.return,
    enter: key.return,
    backspace: key.backspace,
    delete: key.delete,
    up: key.upArrow,
    down: key.downArrow,
    left: key.leftArrow,
    right: key.rightArrow,
    pageup: key.pageUp,
    pagedown: key.pageDown,
    space: input === ' ',
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, key.name === `f${i + 1}`])),
  };
  const flag = named[desc.key];
  if (flag !== undefined) return Boolean(flag) && ctrlOk && altOk && shiftOk;
  // A bare letter/digit binding (e.g. yank "y") must not fire with modifiers.
  return ctrlOk && altOk && shiftOk && !key.escape && input.toLowerCase() === desc.key;
}
