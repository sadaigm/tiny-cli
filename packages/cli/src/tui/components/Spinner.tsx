import React, { useEffect, useState } from 'react';
import { Box, Text } from '../compat.js';

/**
 * Props for the {@link Spinner} component.
 */
export interface SpinnerProps {
  /** Status text displayed next to the spinner animation. */
  text?: string;
  /** Spinner animation type. Defaults to 'dots'. */
  type?: 'dots' | 'dots2' | 'line' | 'line2' | 'arc' | 'bouncingBar' | 'triangle' | 'star' | 'toggle';
  /** Color for the spinner animation. Defaults to 'yellow'. */
  color?: string;
}

/**
 * Frame cycles per spinner type (port of the ink-spinner/cli-spinners frames
 * we used — OpenTUI ships no spinner, so we cycle frames ourselves).
 */
const FRAMES: Record<NonNullable<SpinnerProps['type']>, string[]> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  dots2: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  line: ['-', '\\', '|', '/'],
  line2: ['⠂', '⠂', '⠒', '⠒', '⠐', '⠐', '⠰', '⠰', '⠠', '⠠'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
  bouncingBar: ['[    ]', '[=   ]', '[==  ]', '[=== ]', '[ ===]', '[  ==]', '[   =]', '[    ]'],
  triangle: ['▲', '▶', '▼', '◀'],
  star: ['✶', '✸', '✹', '✺', '✹', '✷'],
  toggle: ['■', '□', '▪', '▫'],
};

const INTERVAL_MS = 80;

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
export default function Spinner({ text, type = 'dots', color = 'yellow' }: SpinnerProps): React.ReactNode {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  const frames = FRAMES[type];
  return (
    <Box>
      <Text color={color}>{frames[tick % frames.length]}</Text>
      {text ? <Text> {text}</Text> : null}
    </Box>
  );
}
