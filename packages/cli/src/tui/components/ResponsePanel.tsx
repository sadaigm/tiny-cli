import React, { useSyncExternalStore } from 'react';
import { Box, Text } from '../compat.js';
import { useStreamStore } from './StreamProvider.js';
import MarkdownBody from './MarkdownBody.js';
import { markdownToLines } from '../utils/markdown.js';
import { getTheme } from '../theme.js';

/**
 * Live assistant-response panel — the only component that re-renders on a
 * text delta. Reads from the StreamStore; at turn end the accumulated text
 * is committed as a normal assistant log entry and this renders nothing.
 *
 * The live response streams in full — unlike thinking (collapsed to a
 * one-line hint) or tool summaries (one-line headers), the user needs to
 * read the agent's words as they arrive. The surrounding log pane is
 * already height-capped by {@link MessageLog}, so a long response scrolls
 * within the pane instead of growing the layout.
 *
 * Markdown renders through the same {@link markdownToLines} layout the
 * committed entries use; no streaming special-casing — every delta re-runs
 * the pure function, and unterminated markers render literally until the
 * closing marker arrives. `maxLines` caps the panel to its tail so it can
 * never overflow the pane (see MessageLog's reserve math).
 */
export default function ResponsePanel({ columns = 80, maxLines }: { columns?: number; maxLines?: number }): React.ReactNode | null {
  const store = useStreamStore();
  const section = useSyncExternalStore(store.subscribeResponse, store.getResponse);
  if (!section.active || !section.text) return null;

  const theme = getTheme();
  const all = markdownToLines(section.text, Math.max(1, columns - 3));
  // Cap to a tail slice: the live panel must stay bounded or it overflows
  // the fixed-height pane and draws over the cards above it. MessageLog
  // reserves the same budget in its window math.
  const hidden = maxLines !== undefined ? Math.max(0, all.length - maxLines) : 0;
  const lines = maxLines === undefined ? all : all.slice(-maxLines);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.assistant}>  🤖 Agent:</Text>
        {hidden > 0 ? <Text dimColor>{`  ⤤ ${hidden} lines above`}</Text> : null}
      </Box>
      <Box marginLeft={3}>
        <MarkdownBody lines={lines} color={undefined} />
      </Box>
    </Box>
  );
}
