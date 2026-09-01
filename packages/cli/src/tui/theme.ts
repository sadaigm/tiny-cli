/**
 * TUI colour theme.
 *
 * A theme maps semantic roles (user message, error, border accent…) to
 * Chalk/Ink colour names. Themes load from `~/.tiny-cli/theme.json` —
 * unknown or invalid values fall back to the default per key, so a
 * hand-edited file can never break rendering.
 *
 * File format (all keys optional):
 *
 *   {
 *     "user": "green", "assistant": "blue", "toolCall": "cyan",
 *     "border": "cyan", "accent": "magenta", "error": "red", ...
 *   }
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { readFirstExisting } from './keybindings.js';

/** Semantic colour roles used across the TUI. */
export interface Theme {
  /** User-submitted messages and the input prompt chevron. */
  user: string;
  /** Assistant messages. */
  assistant: string;
  /** Assistant reasoning / thinking text (rendered dimmed). */
  reasoning: string;
  /** Tool-call summaries. */
  toolCall: string;
  /** Tool-result summaries. */
  toolResult: string;
  /** System / info lines. */
  system: string;
  /** Error text. */
  error: string;
  /** Conversation pane border. */
  border: string;
  /** Bottom status panel border — the mode-tinted instrument frame. */
  borderStatus: string;
  /** Bottom banner/status text (tiny-cli title, mode badge). */
  statusText: string;
  /** Mode badges, highlights, the agent-details accent. */
  accent: string;
  /** Warning highlights (approval modal border, queue notices). */
  warning: string;
}

/**
 * Built-in palette (chat-redesign: dark slate, amber accent, teal tools).
 *
 * ANSI names rather than exact hex: the web renderer (ink-web) ships a chalk
 * shim without `.hex`, so hex defaults would crash the browser build. Hex
 * remains valid in `theme.json` for truecolor terminal users.
 */
export const DEFAULT_THEME: Theme = {
  user: 'green',
  assistant: 'blueBright',
  reasoning: 'gray',
  toolCall: 'cyanBright',
  toolResult: 'gray',
  system: 'gray',
  error: 'red',
  border: 'gray',
  borderStatus: 'gray',
  statusText: 'whiteBright',
  accent: 'yellowBright',
  warning: 'yellow',
};

const THEME_FILE = path.join(os.homedir(), '.tiny-cli', 'theme.json');
/** Project-first (like agents.json): `<cwd>/.tiny-cli/theme.json` wins over the home copy. */
const PROJECT_THEME_FILE = path.join(process.cwd(), '.tiny-cli', 'theme.json');

/**
 * The active theme — set once by {@link setTheme} at startup (render.tsx),
 * read by any component via {@link getTheme}. A module singleton avoids
 * threading a colour prop through every component for a value that never
 * changes mid-session.
 */
let activeTheme: Theme = DEFAULT_THEME;

/** Install the active theme (call once before mounting the TUI). */
export function setTheme(theme: Theme): void {
  activeTheme = theme;
}

/** The active theme (default palette until {@link setTheme} runs). */
export function getTheme(): Theme {
  return activeTheme;
}

/** Colour names Ink/Chalk accept — anything else is rejected. */
const VALID_COLORS = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'gray', 'grey', 'blackBright', 'redBright', 'greenBright', 'yellowBright',
  'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
]);

/**
 * A colour spec is valid when it's a named ANSI colour or a hex string
 * (`#rgb` / `#rrggbb`) — Ink's `color` prop accepts both, so themes can
 * use exact palette values (e.g. "#eb5e28") instead of the coarse
 * 16-colour approximations.
 */
function isValidColor(value: string): boolean {
  if (VALID_COLORS.has(value)) return true;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * Load the theme from `~/.tiny-cli/theme.json`.
 *
 * Reads synchronously at startup (before the first render — an async theme
 * would flash the default palette); a missing or invalid file yields the
 * default theme.
 */
export function loadTheme(): Theme {
  const raw = readFirstExisting(PROJECT_THEME_FILE, THEME_FILE);
  if (raw === null) return { ...DEFAULT_THEME };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof Theme, unknown>>;
    const theme: Theme = { ...DEFAULT_THEME };
    for (const key of Object.keys(DEFAULT_THEME) as (keyof Theme)[]) {
      const value = parsed[key];
      if (typeof value === 'string' && isValidColor(value)) {
        theme[key] = value;
      }
    }
    return theme;
  } catch {
    return { ...DEFAULT_THEME };
  }
}
