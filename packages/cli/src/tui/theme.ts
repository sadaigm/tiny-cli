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

/** Semantic colour roles used across the TUI. */
export interface Theme {
  /** User-submitted messages and the input prompt chevron. */
  user: string;
  /** Assistant messages. */
  assistant: string;
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
  /** Mode badges, highlights, the agent-details accent. */
  accent: string;
  /** Warning highlights (approval modal border, queue notices). */
  warning: string;
}

/** Built-in palette (matches the pre-theme hard-coded colours). */
export const DEFAULT_THEME: Theme = {
  user: 'green',
  assistant: 'blue',
  toolCall: 'cyan',
  toolResult: 'gray',
  system: 'gray',
  error: 'red',
  border: 'cyan',
  accent: 'magenta',
  warning: 'yellow',
};

const THEME_FILE = path.join(os.homedir(), '.tiny-cli', 'theme.json');

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
 * Load the theme from `~/.tiny-cli/theme.json`.
 *
 * Reads synchronously at startup (before the first render — an async theme
 * would flash the default palette); a missing or invalid file yields the
 * default theme.
 */
export function loadTheme(): Theme {
  try {
    const raw = fs.readFileSync(THEME_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Record<keyof Theme, unknown>>;
    const theme: Theme = { ...DEFAULT_THEME };
    for (const key of Object.keys(DEFAULT_THEME) as (keyof Theme)[]) {
      const value = parsed[key];
      if (typeof value === 'string' && VALID_COLORS.has(value)) {
        theme[key] = value;
      }
    }
    return theme;
  } catch {
    return { ...DEFAULT_THEME };
  }
}
