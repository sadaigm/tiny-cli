import React, { useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { wrapIndent } from '../utils/toolSummary.js';
import { useStreamStore } from './StreamProvider.js';
import { renderBodyWithLinks } from './MessageItem.js';
import { getTheme } from '../theme.js';

/** Live response body is capped to a tail window — the pane never grows per token. */
const MAX_LIVE_RESPONSE_LINES = 8;

/**
 * Live assistant-response panel — the only component that re-renders on a
 * text delta. Reads from the StreamStore; at turn end the accumulated text
 * is committed as a normal assistant log entry and this renders nothing.
 */
export default function ResponsePanel({ columns = 80 }: { columns?: number }): React.ReactElement | null {
  const store = useStreamStore();
  const section = useSyncExternalStore(store.subscribeResponse, store.getResponse);
  if (!section.active || !section.text) return null;

  const theme = getTheme();
  const fullBody = wrapIndent(section.text, 3, columns);
  const fullLines = fullBody.split('\n');
  const hidden = Math.max(0, fullLines.length - MAX_LIVE_RESPONSE_LINES);
  const body = hidden
    ? fullLines.slice(fullLines.length - MAX_LIVE_RESPONSE_LINES).join('\n')
    : fullBody;
  const hiddenHint = hidden ? `  ⤴ ${hidden} lines above` : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.assistant}>  🤖 Agent:</Text>
        {hiddenHint ? <Text dimColor>{hiddenHint}</Text> : null}
      </Box>
      <Box marginLeft={3}>{renderBodyWithLinks(body, undefined)}</Box>
    </Box>
  );
}
