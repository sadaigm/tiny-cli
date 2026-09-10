import { useCallback, type RefObject } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useInput, type InkKey } from '../../compat.js';
import { bindingFor, matchesBinding } from '../../keybindings.js';
import { logDebug } from '@tiny-cli/core/src/logger.js';

export interface UseEditorKeysProps {
  /** Editor renderable ref (plainText read at submit time). */
  ref: RefObject<TextareaRenderable | null>;
  /** Mirror of the controlled value for freshest reads in handlers. */
  valueRef: RefObject<string>;
  /** Called when the user presses plain Enter (submit). */
  onSubmit?: (value: string) => void;
  /** Ctrl+R handler (opens reverse-i-search). */
  onSearch?: () => void;
  focus: boolean;
}

/**
 * Global key handling for {@link TextInput}, extracted so the component's
 * render path stays thin (also isolates it for debugging).
 *
 * Only keys the editor must NOT see for itself are intercepted (they run
 * before the focused renderable): Enter (submit vs Shift+Enter newline),
 * Ctrl+R (history search), Tab (picker accept). Everything else is the
 * textarea's native behavior.
 */
export function useEditorKeys({
  ref,
  valueRef,
  onSubmit,
  onSearch,
  focus,
}: UseEditorKeysProps) {
  const handler = useCallback(
    (input: string, key: InkKey) => {
      // Enter: plain submits, Shift+Enter inserts a newline (kitty protocol
      // distinguishes the two; on legacy terminals both submit, as before).
      if (key.return) {
        key.preventDefault(); // never let the editor insert its own newline
        if (key.shift) {
          ref.current?.insertText('\n');
        } else {
          onSubmit?.(ref.current?.plainText ?? valueRef.current ?? '');
        }
        return;
      }
      logDebug(`TextInput: input=${JSON.stringify(input)}, key=${JSON.stringify(key)}`);
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
    [ref, valueRef, onSubmit, onSearch],
  );

  useInput(handler, { isActive: focus });
}
