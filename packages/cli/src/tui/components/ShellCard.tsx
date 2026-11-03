import React from 'react';

import { Box, Text } from '../compat.js';
import { truncate } from '../utils/toolSummary.js';

/** Same 80% card width as MessageItem's CARD_WIDTH_RATIO (kept local to
 * avoid a circular import; the estimator mirrors both). */
const CARD_WIDTH_RATIO = 0.8;

/**
 * Shell output card (bang-mode `! cmd`): its own component — not a variant
 * of the generic tool {@link Card} — so shell presentation (a `$`-prefixed
 * header, exit-code slot, own theme shade) can evolve independently.
 *
 * Same shared language as the other cards: 80% pane width, borderless
 * background shade, one header row (chevron + `$ shell` + right-aligned
 * `+N lines` hint), click/keyboard toggle via the caller's onToggle.
 */
export function shellCardColumnsOf(columns: number): number {
  return Math.max(10, Math.floor(columns * CARD_WIDTH_RATIO));
}

export default function ShellCard({
  background,
  color,
  right,
  expanded,
  expandable,
  columns,
  onToggle,
  children,
}: {
  background: string;
  color: string;
  /** Dim right-aligned hint (e.g. `+8 lines`); empty when expanded. */
  right: string;
  expanded: boolean;
  /** True when the body has hidden lines to expand into. */
  expandable: boolean;
  columns: number;
  onToggle?: () => void;
  children?: React.ReactNode;
}): React.ReactNode {
  const chev = expandable ? (expanded ? '⌃' : '⌄') : ' ';
  const titleMax = Math.max(4, columns - right.length - 8);
  return (
    <Box
      backgroundColor={background}
      paddingLeft={1}
      paddingRight={1}
      width={columns}
      alignSelf="flex-start"
      flexDirection="column"
    >
      <Box justifyContent="space-between" onMouseDown={onToggle ? () => onToggle() : undefined}>
        <Text color={color}>
          {chev} $ {truncate('shell', titleMax)}
        </Text>
        <Text dimColor>{right}</Text>
      </Box>
      {children}
      <Box height={1}>
        <Text> </Text>
      </Box>
    </Box>
  );
}
