import { useCallback, useMemo, useState } from 'react';
import { searchFiles } from '../../../file-mention.js';
import { SLASH_COMMANDS, type SlashCommand } from '../../utils/commands.js';

/**
 * Slash-command + @file-mention picker state (extracted from InputBox).
 *
 * The pickers are owned entirely by the input: typing `/` at the start (or
 * `@` anywhere) opens one, further chars filter it, ↑/↓ navigate,
 * Enter/Tab accept. The `[@path]` token is expanded into file contents by
 * `hydrateMessage()` on submit; `/name` is submitted directly.
 */
export function usePickers({
  fileIndex,
  onSubmit,
  setValue,
  setCursorEndSignal,
}: {
  /** Workspace file paths for the `@file` picker. */
  fileIndex: string[];
  /** Submit callback (slash commands with no args submit `/name` directly). */
  onSubmit: (text: string) => void;
  /** InputBox's value setter — accepting a mention rewrites the draft. */
  setValue: React.Dispatch<React.SetStateAction<string>>;
  /** Bump to snap the editor cursor to the end after a programmatic edit. */
  setCursorEndSignal: React.Dispatch<React.SetStateAction<number>>;
}) {
  // --- @file-mention picker (local state) ----------------------------------
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');

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
      setCursorEndSignal((n) => n + 1);
    },
    [setValue, setCursorEndSignal],
  );

  // --- /command picker (local state) ---------------------------------------
  // Mirrors the @file picker: typing `/` at the start of the (empty) input
  // opens a menu of commands; further chars filter; ↑/↓ navigate; Enter/Tab
  // runs the command (clears the input and submits `/name`).
  const [slashActive, setSlashActive] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');

  const slashItems: SlashCommand[] = useMemo(() => {
    if (!slashActive) return [];
    const q = slashQuery.toLowerCase();
    const matches = q === '' ? SLASH_COMMANDS : SLASH_COMMANDS.filter((c) => c.name.includes(q));
    return matches;
  }, [slashActive, slashQuery]);

  /** Run a slash command: clear input, close picker, submit `/name`.
   *  Commands that take arguments are inserted for completion instead. */
  const acceptSlash = useCallback(
    (cmdValue: string) => {
      // Extract command name from the value (e.g., "/agent" -> "agent")
      const cmdName = cmdValue.replace(/^\//, '');
      const cmd = SLASH_COMMANDS.find(c => `/${c.name}` === cmdValue);

      setSlashActive(false);
      setSlashQuery('');
      setValue('');

      if (cmd?.takesArgs) {
        setValue(`/${cmd.name} `);
        setCursorEndSignal((n) => n + 1);
      } else {
        onSubmit(cmdValue);
      }
    },
    [onSubmit, setValue, setCursorEndSignal],
  );

  /**
   * Picker detection for a new draft value (the InputBox `handleChange`
   * routes every edit through this): `/` at the very start opens the
   * command picker; `@` anywhere opens the file-mention picker.
   */
  const detectPickers = useCallback(
    (next: string) => {
      if (next.startsWith('/')) {
        setSlashActive(true);
        setSlashQuery(next.slice(1));
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
      }
    },
    [fileIndex.length, trailingMention],
  );

  return {
    mentionActive,
    mentionQuery,
    mentionItems,
    setMentionActive,
    slashActive,
    slashQuery,
    slashItems,
    setSlashActive,
    acceptMention,
    acceptSlash,
    detectPickers,
  };
}
