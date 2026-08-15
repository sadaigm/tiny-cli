import React from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';

/**
 * Props for the {@link Spinner} component.
 */
export interface SpinnerProps {
  /** Status text displayed next to the spinner animation. */
  text?: string;
  /** Spinner animation type (from cli-spinners). Defaults to 'dots'. */
  type?: 'dots' | 'dots2' | 'line' | 'line2' | 'arc' | 'bouncingBar' | 'triangle' | 'star' | 'toggle';
  /** Color for the spinner animation. Defaults to 'yellow'. */
  color?: string;
}

/**
 * Renders a spinner animation with an optional status text label.
 *
 * Used to indicate that the agent is actively working (thinking, running
 * a tool call, etc.). The spinner is purely visual — it does not block
 * input or any other component.
 *
 * @example
 * ```tsx
 * {agentState === 'running' && <Spinner text="Thinking..." />}
 * ```
 */
export default function Spinner({ text, type = 'dots', color = 'yellow' }: SpinnerProps): React.ReactElement {
  return (
    <Box>
      <Text color={color}>
        <InkSpinner type={type} />
      </Text>
      {text ? <Text> {text}</Text> : null}
    </Box>
  );
}
