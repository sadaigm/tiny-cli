import React, { useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { wrapIndent } from '../utils/toolSummary.js';
import { useStreamStore } from './StreamProvider.js';
import { renderBodyWithLinks } from './MessageItem.js';
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
 */
export default function ResponsePanel({ columns = 80 }: { columns?: number }): React.ReactElement | null {
  const store = useStreamStore();
  const section = useSyncExternalStore(store.subscribeResponse, store.getResponse);
  if (!section.active || !section.text) return null;

  const theme = getTheme();
  const body = wrapIndent(section.text, 3, columns);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.assistant}>  🤖 Agent:</Text>
      </Box>
      <Box marginLeft={3}>{renderBodyWithLinks(body, undefined)}</Box>
    </Box>
  );
}
