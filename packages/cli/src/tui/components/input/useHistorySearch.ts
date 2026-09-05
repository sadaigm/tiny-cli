import { useCallback, useMemo, useRef, useState } from 'react';
import { useInput } from '../../compat.js';
import type { InputHistory } from '../../utils/inputHistory.js';
import { searchHistory } from '../../utils/inputHistory.js';

/**
 * Ctrl+R reverse-i-search state machine (extracted from InputBox).
 *
 * While active, the input line is replaced by a search prompt: typing edits
 * the query, Ctrl+R steps to the next-older match, ↑/↓ pick a match by
 * recency, Enter accepts (recall + close + focus for edits), Esc cancels
 * back to the pre-search draft. Accepted results are never auto-submitted —
 * the user gets to edit first, like a shell.
 */
export function useHistorySearch({
  historyRef,
  value,
  focus,
  showAutocomplete,
  slashActive,
  mentionActive,
  replaceValue,
  handleChangeRef,
  setSlashActive,
  setMentionActive,
}: {
  /** The shared input-history cursor (owned by InputBox). */
  historyRef: React.RefObject<InputHistory>;
  /** Current draft — saved on entry so Esc restores exactly what was typed. */
  value: string;
  /** Whether the input owns the keyboard. */
  focus: boolean;
  /** Parent autocomplete popover flag — search yields to it. */
  showAutocomplete: boolean;
  slashActive: boolean;
  mentionActive: boolean;
  /** InputBox's ↑/↓ recall replace (routes accepted lines through pickers). */
  replaceValue: (next: string) => void;
  /** Ref to InputBox's handleChange, for restoring a cancelled draft. */
  handleChangeRef: React.RefObject<((next: string) => void) | null>;
  setSlashActive: (on: boolean) => void;
  setMentionActive: (on: boolean) => void;
}) {
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOffset, setSearchOffset] = useState(0);
  // Draft saved on entry so Esc restores exactly what was typed.
  const searchDraftRef = useRef('');
  // Mirror for synchronous reads: Ctrl+R + Enter arriving in one stdin
  // chunk would otherwise act on a stale offset.
  const searchOffsetRef = useRef(0);
  searchOffsetRef.current = searchOffset;

  const searchResult = useMemo(
    () => (searchActive ? searchHistory(historyRef.current.toArray(), searchQuery, searchOffset) : null),
    [searchActive, searchQuery, searchOffset, historyRef],
  );

  const closeSearch = useCallback((accepted: string | null) => {
    const restore = accepted ?? searchDraftRef.current;
    setSearchActive(false);
    setSearchQuery('');
    setSearchOffset(0);
    if (accepted !== null) {
      // Route the accepted line through the same change path as ↑/↓ recall
      // so `/` and `@` pickers react to it identically.
      replaceValue(accepted);
    } else {
      handleChangeRef.current?.(restore);
    }
  }, [replaceValue, handleChangeRef]);

  const openSearch = useCallback(() => {
    searchDraftRef.current = value;
    // Pickers can't coexist with the search prompt — close both so their
    // key hooks and popovers stand down.
    setSlashActive(false);
    setMentionActive(false);
    setSearchActive(true);
    setSearchQuery('');
    setSearchOffset(0);
  }, [value, setSlashActive, setMentionActive]);

  const searchKeysActive =
    focus && searchActive && !slashActive && !mentionActive && !showAutocomplete;
  useInput(
    (input, key) => {
      if (key.escape) {
        closeSearch(null);
        return;
      }
      if (key.return) {
        closeSearch(searchResult ? searchResult.entry : null);
        return;
      }
      if ((key.ctrl && input === 'r') || key.upArrow) {
        // Step to the next-older match (or scroll newer with ↑).
        if (searchResult) {
          setSearchOffset(searchOffsetRef.current + (key.upArrow ? -1 : 1));
        }
        return;
      }
      if (key.downArrow) {
        if (searchResult) setSearchOffset(searchOffsetRef.current + 1);
        return;
      }
      if (key.backspace) {
        const next = searchQuery.slice(0, -1);
        setSearchQuery(next);
        setSearchOffset(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + input);
        setSearchOffset(0);
      }
    },
    { isActive: searchKeysActive },
  );

  return { searchActive, searchQuery, searchResult, openSearch, closeSearch };
}
