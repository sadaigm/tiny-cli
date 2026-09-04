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
 * Key syntax: `ctrl+<letter>`, `alt+<letter>`, or a named key (`escape`,
 * `tab`, `f1`…). Case-insensitive; `ctrl+P` == `ctrl+p`.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** The remappable global actions. */
export type BindableAction =
  | 'browse'
  | 'historySearch'
  | 'sessionSwitcher'
  | 'abort'
  | 'yank';

/** Canonical key descriptor: modifier (optional) + base key. */
export interface KeyDescriptor {
  ctrl: boolean;
  alt: boolean;
  /** Lower-cased base key: a single letter, or a named key like `escape`. */
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

/** Named keys Ink reports on the `key` object. */
const NAMED_KEYS = new Set([
  'escape', 'tab', 'return', 'enter', 'backspace', 'delete',
  'up', 'down', 'left', 'right', 'home', 'end',
  'pageup', 'pagedown', 'space',
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
  if (parts.length === 0 || parts.length > 2) return null;
  const base = parts[parts.length - 1];
  const modifier = parts.length === 2 ? parts[0] : '';
  if (modifier && modifier !== 'ctrl' && modifier !== 'alt') return null;
  const validBase = base.length === 1 ? /[a-z]/.test(base) : NAMED_KEYS.has(base);
  if (!validBase) return null;
  return { ctrl: modifier === 'ctrl', alt: modifier === 'alt', key: base };
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
      if (typeof value === 'string') {
        const parsedBinding = parseBinding(value);
        if (parsedBinding) {
          result.bindings[action] = parsedBinding;
          result.loadedFromFile = true;
        }
      }
    }
  } catch {
    // No file or invalid JSON — defaults stand.
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
  },
  desc: KeyDescriptor | null | undefined,
): boolean {
  if (!desc) return false;
  if (desc.ctrl) {
    return Boolean(key.ctrl) && input.toLowerCase() === desc.key && !key.meta;
  }
  if (desc.alt) {
    return Boolean(key.meta) && input.toLowerCase() === desc.key;
  }
  // Named keys.
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
  };
  const flag = named[desc.key];
  if (flag !== undefined) return Boolean(flag) && !key.ctrl && !key.meta;
  // A bare letter binding (e.g. yank "y") must not fire while ctrl/meta held.
  return !key.ctrl && !key.meta && !key.escape && input.toLowerCase() === desc.key;
}
