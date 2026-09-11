import React from 'react';
import { Box, Text } from '../compat.js';

import { getTheme } from '../theme.js';

/**
 * Props for the {@link Header} component.
 */
export interface HeaderProps {
  /** LLM model name (e.g. "gpt-4o"). */
  model: string;
  /** API endpoint URL. */
  endpoint: string;
  /** Current session identifier. */
  sessionId: string;
  /** Optional version string displayed in the banner. */
  version?: string;
}

/**
 * Renders a compact two-line application banner for the bottom agent-details
 * box of the TUI.
 *
 * Line 1: `🚀 tiny-cli` (with optional version) and `model @ endpoint`.
 * Line 2: `Session: <id>`.
 *
 * This component is purely presentational and re-renders only when its
 * props change.
 *
 * @example
 * ```tsx
 * <Header model={config.model} endpoint={config.endpoint} sessionId={sessionId} />
 * ```
 */
function Header({ model, endpoint, sessionId, version }: HeaderProps): React.ReactNode {
  const theme = getTheme();
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.statusText}>
          🚀 tiny-cli{version ? ` v${version}` : ''}
        </Text>
        <Text color={theme.system}>
          {'  ·  '}
          <Text bold color={theme.statusText}>{model}</Text> @ {endpoint}
        </Text>
      </Box>
      <Box>
        <Text color={theme.system}>
          Session: <Text bold color={theme.statusText}>{sessionId}</Text>
        </Text>
      </Box>
    </Box>
  );
}

// Memoize: Header's props (model/endpoint/sessionId) are stable across typing
// and mention toggles, so it should NOT re-render when App re-renders for an
// unrelated state change (e.g. mentionActive flipping).
export default React.memo(Header);
