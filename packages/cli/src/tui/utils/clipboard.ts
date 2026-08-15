/**
 * OSC 52 clipboard writes.
 *
 * OSC 52 is the terminal escape sequence that sets the clipboard: even in
 * an SSH session or tmux, the *local* terminal performs the copy — no
 * xclip/wl-copy dependency, nothing executed. Sequence:
 *
 *   ESC ] 52 ; c ; <base64 payload> ESC \
 *
 * Most modern terminals honour it (iTerm2, Kitty, WezTerm, Alacritty,
 * Windows Terminal, tmux with `set-clipboard on`). Terminals that ignore
 * it simply show nothing — the write is harmless.
 */

/** Encode + wrap a clipboard payload as an OSC 52 sequence. */
export function osc52Sequence(text: string): string {
  // Strip stray CR (OSC payloads must not contain raw control characters).
  const clean = text.replace(/\r/g, '');
  return `\x1B]52;c;${Buffer.from(clean, 'utf-8').toString('base64')}\x07`;
}

/**
 * Copy `text` to the terminal's clipboard via OSC 52.
 *
 * Returns true when a sequence was emitted (the terminal may still choose
 * to ignore it), false when stdout isn't a TTY — in that case there is no
 * terminal to interpret the sequence and writing it would print garbage
 * into a redirected stream.
 */
export function copyToClipboard(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  process.stdout.write(osc52Sequence(text));
  return true;
}

/**
 * The raw text worth copying for a log entry: message content for
 * conversational entries, tool args / result for tool entries (the
 * summaries the log renders are for display, not for pasting).
 */
export function entryClipboardText(entry: {
  type: string;
  content?: string;
  toolArgs?: string;
  toolResult?: string;
}): string {
  if (entry.type === 'tool_call') return entry.toolArgs ?? entry.content ?? '';
  if (entry.type === 'tool_result') return entry.toolResult ?? entry.content ?? '';
  return entry.content ?? '';
}
