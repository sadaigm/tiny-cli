/**
 * Bridge between the renderer's mouse-selection listener (owned by
 * render.tsx, outside the React tree) and the MessageLog footer toast.
 *
 * When a drag selection finishes, render.tsx copies the selected text and
 * emits the counts here; MessageLog subscribes and surfaces them through
 * the same 2-second auto-clearing status line the yank binding uses.
 */

export interface SelectionCopyInfo {
  chars: number;
  words: number;
  copied: boolean;
}

type Listener = (info: SelectionCopyInfo) => void;

let listener: Listener | undefined;

/** Called by MessageLog on mount; returns the unsubscribe fn. */
export function onSelectionCopy(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = undefined;
  };
}

/** Called by render.tsx when a finished selection has been copied. */
export function emitSelectionCopy(info: SelectionCopyInfo): void {
  listener?.(info);
}
