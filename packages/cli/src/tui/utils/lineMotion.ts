/**
 * Vertical cursor motion for multi-line input.
 *
 * Inside a draft containing hard newlines (Shift+Enter), ↑/↓ move the
 * cursor between lines — preserving the column, clamped to the target
 * line's length — instead of recalling input history (which would
 * replace the whole draft). Returns `null` when there is no line to move
 * to, so callers can decide whether the key means something else.
 */

/**
 * Offset after moving one line up (`direction = -1`) or down (`+1`).
 *
 * @param value  The full input text (may contain `\n`).
 * @param offset Current cursor offset into `value`.
 * @param direction `-1` for ↑, `+1` for ↓.
 * @returns The new offset, or `null` when already on the edge line
 *          (or the text has no newlines at all).
 */
export function verticalMoveOffset(value: string, offset: number, direction: -1 | 1): number | null {
  if (!value.includes('\n')) return null;
  const lines = value.split('\n');

  // Locate the cursor's line and column within it. A cursor exactly at a
  // line's end belongs to that line (not the following one).
  let lineStart = 0;
  let line = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const end = lineStart + lines[i].length;
    if (offset <= end) {
      line = i;
      break;
    }
    lineStart = end + 1;
  }
  const col = offset - lineStart;

  const target = line + direction;
  if (target < 0 || target >= lines.length) return null;

  let targetStart = 0;
  for (let i = 0; i < target; i++) targetStart += lines[i].length + 1;
  return targetStart + Math.min(col, lines[target].length);
}
