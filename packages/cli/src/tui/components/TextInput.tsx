import React, { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';
import { chipAt } from '../utils/pasteChip.js';
import { verticalMoveOffset } from '../utils/lineMotion.js';
import { bindingFor, matchesBinding } from '../keybindings.js';
import { getTheme } from '../theme.js';

/**
 * Props for the custom {@link TextInput}.
 *
 * API-compatible subset of `ink-text-input`, with two additions:
 * - **Home / End** jump the cursor to the start / end of the input.
 * - **Shift+Enter** inserts a newline (multi-line input); plain **Enter**
 *   submits.
 *
 * Paste handling lives outside this component — `InputBox` uses Ink's
 * `usePaste`, which delivers a paste as a single string on a dedicated channel
 * (never forwarded to `useInput`). So nothing paste-related needs to be
 * intercepted here.
 */
export interface TextInputProps {
  /** Current value (controlled). */
  value: string;
  /** Called on every edit (typing, deletion, newline insertion). */
  onChange: (value: string) => void;
  /** Called when the user presses plain Enter (submit). */
  onSubmit?: (value: string) => void;
  /** Placeholder shown when the value is empty. */
  placeholder?: string;
  /** Whether the cursor block is shown. */
  showCursor?: boolean;
  /** Whether the input is focused (receives keystrokes). */
  focus?: boolean;
  /**
   * Called when the user presses Ctrl+R. When provided, the input yields
   * the key (used by InputBox to open reverse-i-search of input history).
   */
  onSearch?: () => void;
  /**
   * Increment to snap the cursor to the end on the next render — used when
   * the parent programmatically replaces the value (e.g. the slash picker
   * inserting `/create-skill `), which the clamp effect alone won't reposition.
   */
  cursorToEndSignal?: number;
}

/**
 * A single-or-multi-line text input with an inline cursor.
 *
 * Replaces `ink-text-input` to add:
 * - **Home / End** — move cursor to the start / end of the buffer.
 * - **Shift+Enter** — insert a `\n` (multi-line prompts). Plain Enter submits.
 *
 * Ink 7's `useInput` exposes `home`, `end`, `backspace`, `delete`, and `shift`
 * directly on the `key` object, so every key we care about is handled in the
 * single `useInput` callback — no separate raw-byte listener required (which
 * the old Ink 5/6 version needed because it collapsed several of these keys).
 *
 * The cursor is rendered as an inverse-highlighted character (matching
 * `ink-text-input`'s approach, since a real terminal cursor is awkward under
 * Ink's redraw model).
 *
 * Keystroke handling:
 * - `←` / `→` — move cursor one char
 * - `Backspace` / `Delete` — delete the char before / after the cursor
 * - `Home` / `End` — jump cursor to start / end
 * - `Enter` — submit (`onSubmit`)
 * - `Shift+Enter` — newline
 * - printable char — insert at cursor
 */
export default function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  showCursor = true,
  focus = true,
  onSearch,
  cursorToEndSignal = 0,
}: TextInputProps): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useInput((input, key) => {
    // Yield keys the app uses elsewhere (pickers consume arrows/tab themselves
    // via their own isActive-gated hooks, but ↑/↓ must not move a 1-D cursor).
    if (key.upArrow || key.downArrow || (key.ctrl && input === 'c') || key.tab) {
      // Inside a multi-line draft the arrows belong to the text, not to
      // history recall: move the cursor one display line (column kept).
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        const next = verticalMoveOffset(value, cursorOffset, direction);
        if (next !== null) setCursorOffset(next);
      }
      return;
    }

    // The history-search hotkey (Ctrl+R by default, remappable) opens
    // reverse-i-search of the input history.
    if (matchesBinding(input, key, bindingFor('historySearch')) && onSearch) {
      onSearch();
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorOffset((o) => Math.min(value.length, o + 1));
      return;
    }
    if (key.home) {
      setCursorOffset(0);
      return;
    }
    if (key.end) {
      setCursorOffset(value.length);
      return;
    }

    // Shift+Enter inserts a newline (multi-line input). Plain Enter submits.
    // Ink distinguishes the two when the kitty keyboard protocol is active
    // (enabled at render time); otherwise Shift falls back to a plain submit.
    if (key.return) {
      if (key.shift) {
        onChange(value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset));
        setCursorOffset((o) => o + 1);
        return;
      }
      onSubmit?.(value);
      return;
    }

    // Backspace: delete the char BEFORE the cursor and move the cursor left.
    if (key.backspace) {
      if (cursorOffset > 0) {
        // If the char just before the cursor is part of a paste chip, delete
        // the whole chip as one atomic unit.
        const onChip = chipAt(value, cursorOffset);
        if (onChip) {
          onChange(value.slice(0, onChip.start) + value.slice(onChip.end));
          setCursorOffset(onChip.start);
        } else {
          onChange(value.slice(0, cursorOffset - 1) + value.slice(cursorOffset));
          setCursorOffset((o) => o - 1);
        }
      }
      return;
    }

    // Forward Delete: delete the char AFTER the cursor (cursor stays put).
    if (key.delete) {
      if (cursorOffset < value.length) {
        const onChip = chipAt(value, cursorOffset);
        if (onChip) {
          onChange(value.slice(0, onChip.start) + value.slice(onChip.end));
        } else {
          onChange(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1));
        }
      }
      return;
    }

    // Insert printable character(s) at the cursor.
    if (input && !key.ctrl && !key.meta) {
      const next = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      onChange(next);
      setCursorOffset((o) => o + input.length);
    }
  }, { isActive: focus });

  // Keep the cursor in range when the value changes externally (e.g. the
  // @mention picker inserting a token, or the slash picker clearing input).
  useEffect(() => {
    if (!focus || !showCursor) return;
    setCursorOffset((prev) => {
      if (value.length === 0) return 0;
      return Math.min(prev, value.length);
    });
  }, [value, focus, showCursor]);

  // When focus is (re)gained, place the cursor at the end.
  useEffect(() => {
    if (focus) setCursorOffset(value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Parent-requested snap (programmatic value replacement).
  useEffect(() => {
    if (cursorToEndSignal > 0) setCursorOffset(value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorToEndSignal]);

  return (
    <Text color={value.length > 0 ? getTheme().user : getTheme().system}>
      {value.length > 0
        ? renderValueWithCursor(value, cursorOffset, showCursor && focus)
        : showCursor && focus
          ? inversePlaceholder(placeholder)
          : (placeholder || ' ')}
    </Text>
  );
}

/** Render the value, highlighting the character at the cursor (inverse). */
function renderValueWithCursor(value: string, cursorOffset: number, showCursor: boolean): string {
  if (!showCursor) return value;
  let out = '';
  let i = 0;
  for (const char of value) {
    if (i === cursorOffset) {
      out += inverse(char);
    } else {
      out += char;
    }
    i++;
  }
  // Cursor at end → show an inverse space after the last char.
  if (cursorOffset >= value.length) {
    out += inverse(' ');
  }
  return out;
}

/** Placeholder with the first char highlighted as the cursor. */
function inversePlaceholder(placeholder: string): string {
  if (placeholder.length === 0) return inverse(' ');
  return inverse(placeholder[0]) + placeholder.slice(1);
}

/** ANSI inverse-video wrapper. */
function inverse(text: string): string {
  return `\x1b[7m${text}\x1b[27m`;
}
