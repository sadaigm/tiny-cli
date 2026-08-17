import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

/**
 * A single selectable item in the autocomplete popover.
 *
 * Items may be plain strings or objects with a display label, an
 * optional value (what gets inserted when accepted), and an optional
 * description shown dimmed on the same line.
 */
export type AutocompleteItem =
  | string
  | {
      /** Text shown to the user. */
      label: string;
      /** Value inserted when the item is accepted (defaults to `label`). */
      value?: string;
      /** Optional one-line description rendered dimmed after the label. */
      description?: string;
    };

/**
 * Props for the {@link AutocompletePopover} component.
 */
export interface AutocompletePopoverProps {
  /** Filtered items to display (already filtered by the parent). */
  items: AutocompleteItem[];
  /** Zero-based index of the currently highlighted item. */
  selectedIndex: number;
  /**
   * Maximum number of items visible at once before scrolling.
   * Defaults to {@link DEFAULT_MAX_VISIBLE}.
   */
  maxVisible?: number;
  /**
   * Title rendered as a dimmed header above the list.
   * If omitted, no header is shown.
   */
  title?: string;
}

/** Default number of items shown before the popover scrolls. */
export const DEFAULT_MAX_VISIBLE = 8;

/**
 * Normalises an {@link AutocompleteItem} into a `{ label, value,
 * description }` triple.
 */
function normalizeItem(item: AutocompleteItem): {
  label: string;
  value: string;
  description?: string;
} {
  if (typeof item === 'string') {
    return { label: item, value: item };
  }
  return {
    label: item.label,
    value: item.value ?? item.label,
    description: item.description,
  };
}

/**
 * Computes the scroll window slice so the highlighted item is always
 * visible.
 *
 * @param selectedIndex - The currently selected item index.
 * @param itemCount - Total number of items.
 * @param maxVisible - Maximum visible rows.
 * @returns `{ start, end }` — the `[start, end)` window to display.
 */
function computeScrollWindow(
  selectedIndex: number,
  itemCount: number,
  maxVisible: number,
): { start: number; end: number } {
  if (itemCount <= maxVisible) {
    return { start: 0, end: itemCount };
  }

  let start = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));

  // If we're near the end, anchor the window to the last item
  if (start + maxVisible > itemCount) {
    start = itemCount - maxVisible;
  }

  return { start, end: start + maxVisible };
}

/**
 * Renders a reusable autocomplete popover with keyboard-navigable items.
 *
 * The popover is **presentational** — it displays a list of filtered
 * items with the currently selected item highlighted.  Keyboard
 * navigation (↑/↓ to move, Tab/Enter to accept, Escape to dismiss) is
 * handled by the parent component (typically {@link InputBox}), which
 * updates `selectedIndex` and calls the appropriate accept/dismiss
 * callback.
 *
 * **Scrolling:** When the number of items exceeds `maxVisible`, a
 * sliding window keeps the highlighted item in view.  Indicator arrows
 * (`↑` / `↓`) are shown when there are hidden items above or below the
 * visible window.
 *
 * **Reuse:** Supports both `/` slash commands (with descriptions) and
 * `@` file mentions (plain paths).  Items can be plain strings or
 * `{ label, value, description }` objects.
 *
 * @example
 * ```tsx
 * <AutocompletePopover
 *   items={['/agent', '/chat', '/plan']}
 *   selectedIndex={state.autocompleteSelected}
 *   title="Commands"
 * />
 * ```
 *
 * @example
 * ```tsx
 * <AutocompletePopover
 *   items={[
 *     { label: 'src/index.ts', description: 'entry point' },
 *     'src/config.ts',
 *   ]}
 *   selectedIndex={0}
 *   title="Files"
 * />
 * ```
 */
export default function AutocompletePopover({
  items,
  selectedIndex,
  maxVisible = DEFAULT_MAX_VISIBLE,
  title,
}: AutocompletePopoverProps): React.ReactElement | null {
  // Normalise items once per render
  const normalized = useMemo(
    () => items.map(normalizeItem),
    [items],
  );

  // Guard: nothing to show
  if (normalized.length === 0) return null;

  // Clamp selected index into valid range
  const clampedIndex = Math.max(0, Math.min(selectedIndex, normalized.length - 1));

  const { start, end } = computeScrollWindow(
    clampedIndex,
    normalized.length,
    maxVisible,
  );

  const visibleItems = normalized.slice(start, end);
  const hasMoreAbove = start > 0;
  const hasMoreBelow = end < normalized.length;

  return (
    <Box flexDirection="column" marginTop={0}>
      {title ? (
        <Box>
          <Text dimColor bold>
            {title}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        {hasMoreAbove ? (
          <Text dimColor>↑ {start} more</Text>
        ) : null}
        {visibleItems.map((item, i) => {
          const absoluteIndex = start + i;
          const isSelected = absoluteIndex === clampedIndex;
          return (
            <Box key={`${item.value}-${absoluteIndex}`}>
              <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {isSelected ? '❯ ' : '  '}
                {item.label}
              </Text>
              {item.description ? (
                <Text dimColor>
                  {' '}
                  — {item.description}
                </Text>
              ) : null}
            </Box>
          );
        })}
        {hasMoreBelow ? (
          <Text dimColor>↓ {normalized.length - end} more</Text>
        ) : null}
      </Box>
    </Box>
  );
}
