/**
 * Paste-chip helpers.
 *
 * When the user pastes multi-line text, we collapse it into a readable chip
 * inside the input box — e.g. `[pasted text #1 +3 lines]` — instead of letting
 * the raw text (with its embedded newlines) flood the single-line input and
 * freeze editing. The real pasted text is held in a side store keyed by chip
 * id and re-expanded on submit.
 *
 * The chip text is an atomic unit for editing: a single Backspace on any part
 * of the chip removes the whole chip. This is enforced by {@link TextInput}'s
 * backspace handler, which treats the chip string as a single "character".
 */

/** Regex matching a paste chip anywhere in a string. */
export const PASTE_CHIP_REGEX = /\[pasted text #(\d+) \+\d+ lines?\]/g;

/** Builds the visible chip text for a paste of `id` with `lineCount` lines. */
export function pasteChipText(id: number, lineCount: number): string {
  // "+1 line" vs "+3 lines". A 0-line paste (single line, no newline) still
  // shows the chip because it was a paste event, but we floor the count at 1
  // so the label always reads sensibly.
  const n = Math.max(1, lineCount);
  const plural = n === 1 ? 'line' : 'lines';
  return `[pasted text #${id} +${n} ${plural}]`;
}

/**
 * Normalise paste line endings to `\n`.
 *
 * Pastes can arrive with `\n`, `\r\n` (Windows), or bare `\r` (classic Mac /
 * some terminal emulators). A bare `\r` is dangerous in stored paste content:
 * when the expanded text is later printed, the terminal treats `\r` as
 * "carriage return to column 0" (no line feed), so the next line overstrikes
 * the previous one — making multi-line pastes look scrambled. Normalising to
 * `\n` on storage keeps the content semantically identical while ensuring it
 * renders as real separate lines.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Count the number of lines in pasted text (trailing newline doesn't add one). */
export function countLines(text: string): number {
  if (text.length === 0) return 1;
  // Normalise line endings first (see normalizeLineEndings), then "a\nb" → 2
  // lines, "a\nb\n" → 2 lines (a trailing newline is not a new line).
  const normalised = normalizeLineEndings(text);
  const trimmed = normalised.replace(/\n+$/, '');
  return trimmed.split('\n').length;
}

/**
 * Expand every paste chip in `text` back to its raw pasted content using the
 * `pastes` map (id → raw text). Unknown ids are left as-is (defensive — should
 * not happen in practice since the store is cleared alongside the input).
 */
export function expandPasteChips(text: string, pastes: Map<number, string>): string {
  return text.replace(PASTE_CHIP_REGEX, (chip, idStr) => {
    const id = Number(idStr);
    return pastes.has(id) ? pastes.get(id)! : chip;
  });
}

/**
 * Find the bounds [start, end) of the paste chip that the given cursor index
 * falls inside (including sitting just after the chip — i.e. a Backspace there
 * should delete the whole chip). Returns `null` if `index` isn't on a chip.
 *
 * "On a chip" means anywhere within `[start, end]`: a cursor at `end` (just
 * after the chip's closing `]`) is considered on it because Backspace from
 * there should remove the chip atomically, not peel off the `]`.
 */
export function chipAt(text: string, index: number): { start: number; end: number } | null {
  PASTE_CHIP_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASTE_CHIP_REGEX.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (index >= start && index <= end) {
      return { start, end };
    }
  }
  return null;
}
