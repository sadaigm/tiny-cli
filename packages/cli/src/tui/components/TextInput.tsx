import React, { useEffect, useRef } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useInput } from '../compat.js';
import { getTheme } from '../theme.js';
import { useEditorKeys } from './input/useEditorKeys.js';

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

  // While the input is blurred (a modal overlay or browse mode owns the
  // keyboard), keep every key away from the focused editor renderable —
  // global listeners still run, but nothing may land in the hidden draft.
  useInput(
    (_input, key) => {
      key.preventDefault();
    },
    { isActive: !focus },
  );

  // Editor key handling (Enter / Shift+Enter, Ctrl+R, Tab) lives in
  // input/useEditorKeys.ts — only keys the focused editor must not see.
  useEditorKeys({ ref, valueRef, onSubmit, onSearch, focus });

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
  // If the editor NORMALIZES the text (plainText never equals value, e.g. a
  // trailing-newline representation), adopt the editor's version instead of
  // setText↔onChange ping-ponging into "Maximum update depth exceeded"
  // (seen when holding backspace).
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    if (ta.plainText === value) return;
    ta.setText(value);
    if (ta.plainText !== value) {
      lastReportedRef.current = ta.plainText;
      onChange(ta.plainText);
    }
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
