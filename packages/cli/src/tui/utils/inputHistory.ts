/**
 * Input history for the prompt line.
 *
 * Mirrors the shell experience: submitted inputs are remembered (newest
 * last), ↑ walks backwards through them, ↓ walks forwards, and any edits
 * made while browsing are kept as a draft so returning to the present
 * (or submitting the recalled line) never silently destroys work.
 *
 * The cursor semantics are the standard four-slot model:
 *
 * - cursor === entries.length  → "at the present" (newest + the draft)
 * - cursor < entries.length    → browsing; `current()` returns that entry
 *
 * Consecutive duplicates are collapsed (pressing Enter twice on the same
 * text records it once), and the ring is capped so a long session cannot
 * grow it without bound.
 */

/** Default maximum number of remembered inputs. */
export const DEFAULT_HISTORY_LIMIT = 200;

/**
 * A cursor over an append-only input history.
 *
 * Created once per input line; `push()` on submit, `move()` on ↑/↓,
 * `saveDraft()` whenever the user edits while browsing.
 */
export class InputHistory {
  private entries: string[] = [];
  private draft = '';
  private cursor: number;

  constructor(private readonly limit: number = DEFAULT_HISTORY_LIMIT) {
    // Cursor starts "at the present" — past every recorded entry.
    this.cursor = 0;
  }

  /** Number of remembered entries. */
  get length(): number {
    return this.entries.length;
  }

  /** Whether there is anything to recall. */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** True when the cursor sits at the present (not browsing history). */
  get atPresent(): boolean {
    return this.cursor >= this.entries.length;
  }

  /**
   * Record a submitted input.
   *
   * Empty/whitespace-only text is ignored. A repeat of the most recent
   * entry is not recorded twice. Always returns the cursor to the present
   * and clears the draft, so the next ↑ recalls the line just submitted.
   */
  push(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (this.entries[this.entries.length - 1] !== trimmed) {
      this.entries.push(trimmed);
      if (this.entries.length > this.limit) {
        this.entries.shift();
      }
    }
    this.cursor = this.entries.length;
    this.draft = '';
    return true;
  }

  /**
   * The value the input line should show right now: the browsed entry,
   * or the draft when at the present.
   */
  current(): string {
    return this.atPresent ? this.draft : (this.entries[this.cursor] ?? this.draft);
  }

  /**
   * Preserve the user's in-progress edit.
   *
   * Called on every change while at the present; the draft is what ↓
   * restores after browsing backwards.
   */
  saveDraft(text: string): void {
    if (this.atPresent) this.draft = text;
  }

  /**
   * Move the cursor and return the line to show.
   *
   * @param delta - `-1` for ↑ (older), `+1` for ↓ (newer).
   * @returns The line to display, or `null` when the move is a no-op
   *          (already at the oldest entry, or already at the present).
   */
  move(delta: number): string | null {
    if (this.entries.length === 0) return null;
    let next = this.cursor + delta;
    if (next < 0) next = 0;
    if (next > this.entries.length) next = this.entries.length;
    if (next === this.cursor) return null;
    this.cursor = next;
    return this.current();
  }

  /** Jump the cursor to the present and return the draft. */
  resetToPresent(): string {
    this.cursor = this.entries.length;
    return this.draft;
  }

  /** Remove every entry (used by `/clear`). */
  clear(): void {
    this.entries = [];
    this.draft = '';
    this.cursor = 0;
  }

  /** Read-only view of all entries, oldest first. */
  toArray(): string[] {
    return [...this.entries];
  }
}

/** A single history search result. */
export interface HistorySearchResult {
  /** The matching entry. */
  entry: string;
  /** Index into the searched list (oldest-first). */
  index: number;
  /** 1-based rank from the newest match (1 = newest). */
  matchNumber: number;
  /** Total matches for the query. */
  matchCount: number;
}

/**
 * Case-insensitive substring search over history, newest match first.
 *
 * Backs Ctrl+R reverse-i-search: `offset` counts backwards from the newest
 * match (0 = newest, each further Ctrl+R adds 1) and is clamped to the
 * valid range, so repeated presses can't run past the oldest match. An
 * empty query matches nothing.
 */
export function searchHistory(
  entries: readonly string[],
  query: string,
  offset = 0,
): HistorySearchResult | null {
  if (!query) return null;
  const needle = query.toLowerCase();
  const matched: { entry: string; index: number }[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].toLowerCase().includes(needle)) {
      matched.push({ entry: entries[i], index: i });
    }
  }
  if (matched.length === 0) return null;
  const clamped = Math.min(Math.max(0, offset), matched.length - 1);
  return { ...matched[clamped], matchNumber: clamped + 1, matchCount: matched.length };
}
