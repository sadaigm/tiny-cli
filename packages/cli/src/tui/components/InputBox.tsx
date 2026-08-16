import React, { useState, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { TuiMode, AgentState } from '../state.js';
import AutocompletePopover from './AutocompletePopover.js';
import TextInput from './TextInput.js';
import { searchFiles } from '../../file-mention.js';
import { SLASH_COMMANDS, type SlashCommand } from '../utils/commands.js';
import {
  pasteChipText,
  countLines,
  expandPasteChips,
  normalizeLineEndings,
} from '../utils/pasteChip.js';
import { InputHistory, searchHistory } from '../utils/inputHistory.js';
import { loadHistory, saveHistory } from '../utils/historyStore.js';
import { getTheme } from '../theme.js';

/**
 * Props for the {@link InputBox} component.
 */
export interface InputBoxProps {
  /** Called with the trimmed input when the user presses Enter. */
  onSubmit: (text: string) => void;
  /** Current execution mode — controls the prompt colour and label. */
  mode: TuiMode;
  /** Current agent lifecycle state — shown as a status hint but does NOT disable input. */
  agentState: AgentState;
  /** Placeholder text when the input is empty. */
  placeholder?: string;
  /**
   * Called when the user navigates within an active autocomplete popover
   * (↑/↓ arrows) or accepts a suggestion (Tab).  When provided and
   * `showAutocomplete` is true, arrow keys are intercepted for selection
   * instead of cursor movement.
   */
  onAutocompleteNavigate?: (direction: 'up' | 'down') => void;
  /** Accept the currently highlighted autocomplete suggestion. */
  onAutocompleteAccept?: (selectedItem?: string) => void;
  /** Whether the autocomplete popover is currently active. */
  showAutocomplete?: boolean;
  /** Notifies the parent when the @file-mention picker opens/closes (so it can yield keys). */
  onMentionActiveChange?: (active: boolean) => void;
  /**
   * Notifies the parent when Ctrl+R reverse-i-search opens/closes — the
   * app's global Esc handler must not abort the running turn while the
   * search prompt owns Esc (cancel search).
   */
  onSearchActiveChange?: (active: boolean) => void;
  /**
   * Whether the text input receives keystrokes. False while a modal overlay
   * (approval / recovery / selector) owns the keyboard — its quick-select
   * keys (y/s/n/a, arrows, Enter) must not land in the text draft.
   */
  focus?: boolean;
  /**
   * Workspace file paths used to populate the `@file`-mention picker.
   * When provided, typing `@` opens a fuzzy-matched popover; accepting an
   * item inserts a `[@path]` token (expanded by `hydrateMessage` on submit).
   */
  fileIndex?: string[];
}

/** Colour for the prompt prefix based on execution mode (themed). */
function modeColors(): Record<TuiMode, string> {
  const theme = getTheme();
  return {
    agent: theme.user,
    chat: theme.assistant,
    plan: theme.accent,
  };
}

/**
 * Fixed height reserved for the @file-mention popover (rows). Reserving a
 * constant block — regardless of how many matches there are — prevents the
 * pane above from reflowing/flickering as the filter result count changes.
 */
const MENTION_POPOVER_ROWS = 6;

/** Short label for each mode shown after the chevron. */
const MODE_LABELS: Record<TuiMode, string> = {
  agent: '',
  chat: 'chat',
  plan: 'plan',
};

/**
 * Renders the always-live text input at the bottom of the TUI.
 *
 * **Core design principle:** The input is *always* rendered and always
 * captures keystrokes, regardless of the current {@link AgentState}.
 * This is what allows the user to type while the agent is working —
 * messages are either sent immediately (when idle) or queued (when
 * running), but the input box never freezes.
 *
 * Features:
 * - **Mode-aware prompt prefix**: `❯` in the mode colour, with a mode
 *   label for non-agent modes (e.g. `❯ [chat]`).
 * - **Agent state hint**: When the agent is running or awaiting
 *   approval, a dim hint is shown so the user knows their next message
 *   will be queued.
 * - **Autocomplete integration**: When `showAutocomplete` is true,
 *   arrow keys are intercepted to navigate the popover and Tab/Enter
 *   accept a suggestion.  Otherwise Enter submits the message.
 *
 * @example
 * ```tsx
 * <InputBox
 *   mode={state.mode}
 *   agentState={state.agentState}
 *   onSubmit={handleSubmit}
 *   showAutocomplete={state.showAutocomplete}
 *   onAutocompleteNavigate={handleNavigate}
 *   onAutocompleteAccept={handleAccept}
 * />
 * ```
 */
function InputBox({
  onSubmit,
  mode,
  agentState,
  placeholder = 'Type a message, or use / for commands, @ to mention files…',
  onAutocompleteNavigate,
  onAutocompleteAccept,
  showAutocomplete = false,
  fileIndex = [],
  onMentionActiveChange,
  onSearchActiveChange,
  focus = true,
}: InputBoxProps): React.ReactElement {
  const [value, setValue] = useState('');

  // --- input history -------------------------------------------------------
  // Submitted lines are recalled with ↑/↓ exactly like a shell. The cursor
  // lives in the InputHistory itself; `value` just mirrors current().
  // The history persists per-project across restarts: hydrated from disk
  // on mount (racing an empty history loses nothing — the first ↑ simply
  // has nothing until it lands), saved fire-and-forget on every submit.
  const historyRef = useRef(new InputHistory());
  const historyLoadedRef = useRef(false);
  React.useEffect(() => {
    let cancelled = false;
    loadHistory().then((loaded) => {
      if (cancelled || historyLoadedRef.current) return;
      historyLoadedRef.current = true;
      // Adopt only the loaded entries; anything submitted before the load
      // lands (unlikely — a filesystem read) stays on top.
      for (const entry of loaded.toArray()) historyRef.current.push(entry);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Replace the visible line (used by ↑/↓ recall). */
  const replaceValue = useCallback((next: string) => {
    historyRef.current.saveDraft(next);
    setValue(next);
    // Route through handleChange so `/` and `@` pickers react to a recalled
    // line the same way they react to typing it.
    handleChangeRef.current?.(next);
  }, []);

  // --- paste chips ---------------------------------------------------------
  // Multi-line pastes are collapsed into a readable chip token in `value`
  // (e.g. `[pasted text #1 +3 lines]`); the raw pasted text lives in this map
  // keyed by chip id and is expanded back on submit. The counter is scoped to
  // the current input and resets when the input is cleared (on submit).
  const pastesRef = useRef<Map<number, string>>(new Map());
  const pasteIdRef = useRef(0);

  // handleChange is declared below (it depends on picker state); keep a ref
  // so replaceValue (↑/↓ recall) can route recalled lines through the same
  // picker-detection logic without a use-effect feedback loop.
  const handleChangeRef = useRef<((next: string) => void) | null>(null);

  // --- @file-mention picker (local state) ----------------------------------

  // --- @file-mention picker (local state) ----------------------------------
  // The picker is owned entirely by the input: typing `@` opens it, further
  // chars filter it, ↑/↓ navigate, Enter/Tab accept (inserting `[@path]`),
  // Esc closes. The `[@path]` token is expanded into file contents by
  // `hydrateMessage()` on submit.
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionSelected, setMentionSelected] = useState(0);

  const mentionItems = useMemo(
    () => (mentionActive ? searchFiles(fileIndex, mentionQuery) : []),
    [mentionActive, mentionQuery, fileIndex],
  );

  /** Extract the `@query` at the end of `text`, or null if none. */
  const trailingMention = useCallback((text: string): string | null => {
    const at = text.lastIndexOf('@');
    if (at === -1) return null;
    const after = text.slice(at + 1);
    // The query ends at the first whitespace or another @.
    if (/\s/.test(after) || after.includes('@')) return null;
    return after;
  }, []);

  /**
   * Handle a paste: store the raw text and append a readable chip token to the
   * input. We bypass {@link handleChange} (no `@`/`/` picker detection) because
   * a pasted blob shouldn't open a picker. The chip is expanded back to the raw
   * text on submit via {@link expandPasteChips}.
   *
   * The chip is appended at the end of the current value. Cursor-accurate
   * mid-string paste insertion would require lifting the cursor offset out of
   * TextInput; pastes almost always happen at line-end, so this matches the
   * common case.
   */
  const handlePaste = useCallback((text: string) => {
    // While blurred (browse mode / modal overlay), ignore pastes — the box
    // doesn't own the keyboard, so the draft must not change underneath it.
    if (!focus) return;
    // Normalise line endings up front: pastes may carry \r\n or bare \r, and a
    // bare \r overstrikes when the expanded text is later printed. Storing \n
    // keeps the content semantically identical but display-safe.
    const normalized = normalizeLineEndings(text);
    pasteIdRef.current += 1;
    const id = pasteIdRef.current;
    pastesRef.current.set(id, normalized);
    const chip = pasteChipText(id, countLines(normalized));
    setValue((prev) => prev + chip);
    // A paste can't open the pickers; make sure neither is left dangling.
    setSlashActive(false);
    setMentionActive(false);
  }, []);

  // Ink's usePaste owns bracketed-paste handling on a dedicated channel: it
  // delivers the whole pasted string verbatim and keeps it OUT of useInput, so
  // the paste never leaks into the input as raw text. We collapse it into a
  // readable chip (handlePaste); the raw text is expanded back on submit.
  usePaste(handlePaste);

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      historyRef.current.saveDraft(next);
      // `/` at the very start of the input opens the command picker.
      if (next.startsWith('/')) {
        setSlashActive(true);
        setSlashQuery(next.slice(1));
        setSlashSelected(0);
        setMentionActive(false);
        return;
      }
      setSlashActive(false);
      // `@` anywhere opens the file-mention picker.
      if (fileIndex.length === 0) return;
      const query = trailingMention(next);
      if (query === null) {
        setMentionActive(false);
      } else {
        setMentionActive(true);
        setMentionQuery(query);
        setMentionSelected(0);
      }
    },
    [fileIndex.length, trailingMention],
  );
  handleChangeRef.current = handleChange;

  /** Replace the trailing `@query` with a `[@path]` token and close picker. */
  const acceptMention = useCallback(
    (filePath: string) => {
      setValue((prev) => {
        const at = prev.lastIndexOf('@');
        if (at === -1) return prev;
        return `${prev.slice(0, at)}[@${filePath}] `;
      });
      setMentionActive(false);
      setMentionQuery('');
      setMentionSelected(0);
    },
    [],
  );

  // --- /command picker (local state) ---------------------------------------
  // Mirrors the @file picker: typing `/` at the start of the (empty) input
  // opens a menu of commands; further chars filter; ↑/↓ navigate; Enter/Tab
  // runs the command (clears the input and submits `/name`).
  const [slashActive, setSlashActive] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashSelected, setSlashSelected] = useState(0);

  const slashItems: SlashCommand[] = useMemo(() => {
    if (!slashActive) return [];
    const q = slashQuery.toLowerCase();
    const matches = q === '' ? SLASH_COMMANDS : SLASH_COMMANDS.filter((c) => c.name.includes(q));
    return matches;
  }, [slashActive, slashQuery]);

  /** Run a slash command: clear input, close picker, submit `/name`. */
  const acceptSlash = useCallback(
    (cmd: SlashCommand) => {
      setSlashActive(false);
      setSlashQuery('');
      setSlashSelected(0);
      setValue('');
      onSubmit(`/${cmd.name}`);
    },
    [onSubmit],
  );

  // Notify the parent when ANY picker opens/closes so it can yield keys
  // (the conversation pane must not also claim ↑/↓ while a picker is up).
  React.useEffect(() => {
    onMentionActiveChange?.(
      (mentionActive && mentionItems.length > 0) || (slashActive && slashItems.length > 0),
    );
  }, [mentionActive, mentionItems.length, slashActive, slashItems.length, onMentionActiveChange]);

  // --- Ctrl+R reverse-i-search ---------------------------------------------
  // While active, the input line is replaced by a search prompt: typing
  // edits the query, Ctrl+R steps to the next-older match, ↑/↓ pick a
  // match by recency, Enter accepts (recall + close + focus for edits),
  // Esc cancels back to the pre-search draft. Accepted results are never
  // auto-submitted — the user gets to edit first, like a shell.
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
    [searchActive, searchQuery, searchOffset],
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
      setValue(restore);
      handleChangeRef.current?.(restore);
    }
  }, [replaceValue]);

  const openSearch = useCallback(() => {
    searchDraftRef.current = value;
    // Pickers can't coexist with the search prompt — close both so their
    // key hooks and popovers stand down.
    setSlashActive(false);
    setMentionActive(false);
    setSearchActive(true);
    setSearchQuery('');
    setSearchOffset(0);
  }, [value]);

  // Notify the parent so the app-level Esc handler (abort turn) yields
  // while the search prompt owns Esc (cancel search).
  React.useEffect(() => {
    onSearchActiveChange?.(searchActive);
  }, [searchActive, onSearchActiveChange]);

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

  // --- Submit logic --------------------------------------------------------

  const handleSubmit = useCallback(
    (submittedValue: string) => {
      // If the slash-command picker is open, Enter runs the highlighted command.
      if (slashActive && slashItems[slashSelected]) {
        acceptSlash(slashItems[slashSelected]);
        return;
      }
      // If the mention picker is open, Enter accepts the highlighted file
      // instead of submitting the message.
      if (mentionActive && mentionItems[mentionSelected]) {
        acceptMention(mentionItems[mentionSelected]);
        return;
      }
      // Expand any paste chips back to their raw text before submitting, then
      // trim. hydrateMessage (in the app layer) further expands @file tokens.
      const expanded = expandPasteChips(submittedValue, pastesRef.current);
      const trimmed = expanded.trim();
      if (trimmed.length === 0) return;

      if (showAutocomplete && onAutocompleteAccept) {
        onAutocompleteAccept(trimmed);
        return;
      }

      // Remember the submitted line for ↑/↓ recall before clearing the input.
      historyRef.current.push(trimmed);
      void saveHistory(historyRef.current);
      onSubmit(trimmed);
      // Clear the input and reset the paste store + per-input chip counter.
      setValue('');
      pastesRef.current.clear();
      pasteIdRef.current = 0;
    },
    [
      onSubmit,
      showAutocomplete,
      onAutocompleteAccept,
      mentionActive,
      mentionItems,
      mentionSelected,
      acceptMention,
      slashActive,
      slashItems,
      slashSelected,
      acceptSlash,
    ],
  );

  // --- Picker keyboard navigation (slash commands + @file mentions) --------

  // History recall engages only when no picker is open AND the draft is
  // single-line: inside a multi-line draft (Shift+Enter) the arrows move the
  // cursor line-by-line (TextInput), not the history. When the slash or
  // mention picker is up, ↑/↓ already belong to it; when browse mode has the
  // arrows (InputBox hidden), this component is not mounted at all.
  const historyKeysActive =
    focus &&
    !slashActive &&
    !mentionActive &&
    !showAutocomplete &&
    !searchActive &&
    !value.includes('\n');
  useInput(
    (_input, key) => {
      if (key.upArrow) {
        const recalled = historyRef.current.move(-1);
        if (recalled !== null) replaceValue(recalled);
      } else if (key.downArrow) {
        const recalled = historyRef.current.move(1);
        if (recalled !== null) replaceValue(recalled);
      }
    },
    { isActive: historyKeysActive },
  );

  const pickerActive = focus && (slashActive || mentionActive);
  useInput(
    (_input, key) => {
      // Slash-command picker
      if (slashActive) {
        if (key.upArrow) {
          setSlashSelected((i) => (i - 1 + slashItems.length) % slashItems.length);
        } else if (key.downArrow) {
          setSlashSelected((i) => (i + 1) % slashItems.length);
        } else if (key.tab || key.return) {
          if (slashItems[slashSelected]) acceptSlash(slashItems[slashSelected]);
        } else if (key.escape) {
          setSlashActive(false);
        }
        return;
      }
      // @file-mention picker
      if (!mentionActive) return;
      if (key.upArrow) {
        setMentionSelected((i) => (i - 1 + mentionItems.length) % mentionItems.length);
      } else if (key.downArrow) {
        setMentionSelected((i) => (i + 1) % mentionItems.length);
      } else if (key.tab || key.return) {
        if (mentionItems[mentionSelected]) acceptMention(mentionItems[mentionSelected]);
      } else if (key.escape) {
        setMentionActive(false);
      }
    },
    { isActive: pickerActive },
  );

  // --- Render ---------------------------------------------------------------

  const modeColor = modeColors()[mode];
  const modeLabel = MODE_LABELS[mode];

  return (
    <Box flexDirection="column">
      {searchActive ? (
        /* Reverse-i-search prompt replaces the input line while active. */
        <Box>
          <Text color={getTheme().statusText} bold>
            (r-search)
          </Text>{' '}
          <Text dimColor>`</Text>
          <Text color={getTheme().statusText}>{searchQuery}</Text>
          <Text dimColor>`</Text>{' '}
          <Text dimColor>: </Text>
          {searchResult ? (
            <Text>
              <Text dimColor>({searchResult.matchNumber}/{searchResult.matchCount}) </Text>
              <Text color={getTheme().user}>{searchResult.entry}</Text>
            </Text>
          ) : (
            <Text dimColor italic>
              {searchQuery ? 'no matches' : 'type to search history'}
            </Text>
          )}
        </Box>
      ) : (
        <Box>
          <Text color={modeColor} bold>
            ❯
          </Text>
          {modeLabel ? (
            <Text color={modeColor}> [{modeLabel}]</Text>
          ) : null}
          <Box flexGrow={1} marginLeft={1}>
            <TextInput
              value={value}
              onChange={handleChange}
              onSubmit={handleSubmit}
              placeholder={placeholder}
              showCursor={true}
              focus={focus}
              onSearch={openSearch}
            />
          </Box>
        </Box>
      )}
      {/* Slash-command picker (takes priority over the mention picker —
          `/` and `@` detection are mutually exclusive). */}
      {slashActive && slashItems.length > 0 ? (
        <Box height={MENTION_POPOVER_ROWS} flexDirection="column">
          <AutocompletePopover
            title={`Commands (/${slashQuery})`}
            items={slashItems.map((c) => ({ label: `/${c.name}`, description: c.description }))}
            selectedIndex={slashSelected}
            maxVisible={MENTION_POPOVER_ROWS - 1}
          />
        </Box>
      ) : mentionActive && mentionItems.length > 0 ? (
        /* @file-mention picker — reserve a FIXED-height block so its changing
           item count never reflows the conversation pane above (flicker). */
        <Box height={MENTION_POPOVER_ROWS} flexDirection="column">
          <AutocompletePopover
            title={`Mention file (@${mentionQuery})`}
            items={mentionItems}
            selectedIndex={mentionSelected}
            maxVisible={MENTION_POPOVER_ROWS - 1}
          />
        </Box>
      ) : null}
    </Box>
  );
}

// Memoize so streaming log deltas don't re-render the input row (its siblings
// Header/StatusBar/MessageLog are memoized the same way). Props are stable
// across streaming: mode/agentState are primitives, callbacks are useCallback'd
// or useState setters, fileIndex is loaded once.
export default React.memo(InputBox);
