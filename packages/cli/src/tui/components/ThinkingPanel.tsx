import React, { useSyncExternalStore } from 'react';
import { Box, Text } from '../compat.js';
import { wrapIndent } from '../utils/toolSummary.js';
import { useStreamStore } from './StreamProvider.js';
import { renderBodyWithLinks } from './MessageItem.js';
import { getTheme } from '../theme.js';

/** Live thinking collapses to a single line beyond this many wrapped lines. */
const MAX_LIVE_THINKING_LINES = 3;
/** …or beyond this many accumulated characters (long single-line streams). */
const MAX_LIVE_THINKING_CHARS = 600;

/**
 * Live reasoning panel — the only component that re-renders on a thinking
 * delta. Reads from the StreamStore (useSyncExternalStore), so no React
 * state above it is involved while the model thinks. Once the phase ends
 * the store commits the full text as a normal (collapsed) reasoning log
 * entry and this panel renders nothing.
 */
export default function ThinkingPanel({ columns = 80 }: { columns?: number }): React.ReactNode | null {
  const store = useStreamStore();
  const section = useSyncExternalStore(store.subscribeThinking, store.getThinking);
  if (!section.active || !section.text) return null;

  const theme = getTheme();
  const fullBody = wrapIndent(section.text, 3, columns);
  const fullLines = fullBody.split('\n');
  const overflow =
    fullLines.length > MAX_LIVE_THINKING_LINES || section.text.length > MAX_LIVE_THINKING_CHARS;
  const body = overflow ? fullLines.slice(0, 1).join('\n') : fullBody;
  const hiddenHint = overflow ? `  ⤤ +${fullLines.length - 1} lines` : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.reasoning}>  💭 Thinking:</Text>
        {hiddenHint ? <Text dimColor>{hiddenHint}</Text> : null}
      </Box>
      <Box marginLeft={3}>{renderBodyWithLinks(body, 'gray')}</Box>
    </Box>
  );
}
