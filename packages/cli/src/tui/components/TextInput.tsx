import React, { useState, useEffect, useRef } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useInput } from '../compat.js';
import { bindingFor, matchesBinding } from '../keybindings.js';
import { getTheme } from '../theme.js';

/**
 * Props for the {@link TextInput} — API-compatible with the previous custom
 * editor so {@link InputBox} is unchanged.
 *
 * OpenTUI port: the editor core is now the native `<textarea>` renderable
 * (cursor movement, Home/End, selection, unicode, and paste insertion are
 * handled natively). This wrapper keeps the controlled-value API and adds:
 * - **Home / End** — native.
 * - **Shift+Enter** inserts a newline (multi-line input); plain **Enter**
 *   submits.
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
  /** Ignored (kept for API compatibility) — the native cursor is used. */
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
   * inserting `/create-skill `).
   */
  cursorToEndSignal?: number;
}

/**
 * A single-or-multi-line text input backed by OpenTUI's `<textarea>`.
 *
 * Only the keys the editor must NOT see for itself are intercepted globally
 * (they run before the focused renderable): Enter (submit vs Shift+Enter
 * newline), Ctrl+R (history search), and Tab (picker accept). Everything
 * else — arrows, Home/End, Backspace/Delete, character insertion, paste —
 * is the textarea's native behavior.
 *
 * The controlled `value` is synced both ways:
 * - editor edits → `onContentChange` → `onChange`
 * - external changes (history recall, picker insertion, paste chips) →
 *   `setText` in an effect, guarded so editor-originated changes don't loop.
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
  const ref = useRef<TextareaRenderable | null>(null);
  // Mirror for reading the freshest value inside event handlers.
  const valueRef = useRef(value);
  valueRef.current = value;
  // The editor fires onContentChange with UNCHANGED text around some key
  // handling (e.g. Enter) — a duplicate report whose propagation would
  // re-assert stale content over a parent-driven clear in the same React
  // batch. Consecutive duplicate reports are no-ops: drop them.
  const lastReportedRef = useRef<string | null>(null);
  const theme = getTheme();
  // Suppresses the sync effect for one render when the editor itself just
  // reported this exact text (avoids a setText on every keystroke).
  const [, forceSyncTick] = useState(0);

  // While the input is blurred (a modal overlay or browse mode owns the
  // keyboard), keep every key away from the focused editor renderable —
  // global listeners still run, but nothing may land in the hidden draft.
  useInput(
    (_input, key) => {
      key.preventDefault();
    },
    { isActive: !focus },
  );

  useInput(
    (input, key) => {
      // Enter: plain submits, Shift+Enter inserts a newline (kitty protocol
      // distinguishes the two; on legacy terminals both submit, as before).
      if (key.return) {
        key.preventDefault(); // never let the editor insert its own newline
        if (key.shift) {
          ref.current?.insertText('\n');
        } else {
          onSubmit?.(ref.current?.plainText ?? valueRef.current);
        }
        return;
      }
      // The history-search hotkey (Ctrl+R by default, remappable) opens
      // reverse-i-search of the input history.
      if (matchesBinding(input, key, bindingFor('historySearch')) && onSearch) {
        key.preventDefault();
        onSearch();
        return;
      }
      // Tab belongs to the pickers (accept) — never insert a tab char.
      // Arrows are either picker/history navigation (those handlers
      // preventDefault) or native cursor movement in a multi-line draft.
      // Ctrl+C is handled at the app level.
      if (key.tab) {
        key.preventDefault();
        return;
      }
    },
    { isActive: focus },
  );

  // Focus / blur control (modal overlays steal the keyboard via focus=false).
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    if (focus) ta.focus();
    else ta.blur();
  }, [focus]);

  // External value changes (↑/↓ recall, picker insertion, paste chips, clear
  // on submit) push into the editor. Editor-originated changes already match
  // (onContentChange reported them), so the guard prevents a feedback loop.
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    if (ta.plainText !== value) ta.setText(value);
    forceSyncTick((n) => n + 1);
  }, [value]);

  // When focus is (re)gained, place the cursor at the end.
  useEffect(() => {
    if (focus) ref.current?.gotoBufferEnd();
  }, [focus]);

  // Parent-requested snap (programmatic value replacement).
  useEffect(() => {
    if (cursorToEndSignal > 0) ref.current?.gotoBufferEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorToEndSignal]);

  return (
    <textarea
      ref={ref}
      width="100%"
      placeholder={placeholder}
      placeholderColor={theme.system}
      textColor={theme.user}
      focusedTextColor={theme.user}
      backgroundColor="transparent"
      focusedBackgroundColor="transparent"
      onContentChange={() => {
        const text = ref.current?.plainText ?? '';
        if (text === lastReportedRef.current) return; // spurious duplicate
        lastReportedRef.current = text;
        if (text !== valueRef.current) onChange(text);
      }}
    />
  );
}
