import { useCallback, type RefObject } from 'react';
import { expandPasteChips } from '../../utils/pasteChip.js';
import { saveHistory } from '../../utils/historyStore.js';
import type { InputHistory } from '../../utils/inputHistory.js';

export interface UseInputSubmitProps {
  /** Called with the trimmed, chip-expanded input when the user presses Enter. */
  onSubmit: (text: string) => void;
  /** Paste-chip store (chip id → raw pasted text), owned by InputBox. */
  pastesRef: RefObject<Map<number, string>>;
  /** Chip-id counter, reset together with the store on submit. */
  pasteIdRef: RefObject<number>;
  /** Persisted input history, owned by InputBox. */
  historyRef: RefObject<InputHistory>;
  /** Clears the draft on submit. */
  setValue: (next: string) => void;
  showAutocomplete: boolean;
  onAutocompleteAccept?: (selectedItem?: string) => void;
  mentionActive: boolean;
  mentionItemsLength: number;
  slashActive: boolean;
  slashItemsLength: number;
}

/**
 * Submit logic for {@link InputBox}, extracted so the render path stays
 * thin (also isolates it for debugging).
 *
 * Expand paste chips → trim → let an open picker keep Enter (accept, not
 * submit) → let the autocomplete layer take Enter → push to history →
 * clear the draft and paste store.
 */
export function useInputSubmit({
  onSubmit,
  pastesRef,
  pasteIdRef,
  historyRef,
  setValue,
  showAutocomplete,
  onAutocompleteAccept,
  mentionActive,
  mentionItemsLength,
  slashActive,
  slashItemsLength,
}: UseInputSubmitProps) {
  const handleSubmit = useCallback(
    (submittedValue: string) => {
      // Expand any paste chips back to their raw text before submitting, then
      // trim. hydrateMessage (in the app layer) further expands @file tokens.
      const expanded = expandPasteChips(submittedValue, pastesRef.current ?? new Map());
      const trimmed = expanded.trim();
      if (trimmed.length === 0) return;

      // While a picker is open, Enter belongs to it (accept the highlighted
      // item), not to submit — otherwise the draft would be sent as-is.
      if ((mentionActive && mentionItemsLength > 0) || (slashActive && slashItemsLength > 0)) {
        return;
      }

      if (showAutocomplete && onAutocompleteAccept) {
        onAutocompleteAccept(trimmed);
        return;
      }

      // Remember the submitted line for ↑/↓ recall before clearing the input.
      historyRef.current?.push(trimmed);
      void saveHistory(historyRef.current);
      onSubmit(trimmed);
      // Clear the input and reset the paste store + per-input chip counter.
      setValue('');
      pastesRef.current?.clear();
      if (pasteIdRef.current !== null) pasteIdRef.current = 0;
    },
    [
      onSubmit,
      showAutocomplete,
      onAutocompleteAccept,
      mentionActive,
      mentionItemsLength,
      slashActive,
      slashItemsLength,
      pastesRef,
      pasteIdRef,
      historyRef,
      setValue,
    ],
  );

  return handleSubmit;
}
