import React, { useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from '../compat.js';

interface PlanConfirmModalProps {
  /** Number of incomplete tasks found in `current_task.md`. */
  taskCount: number;
  onSelect: (execute: boolean) => void;
}

/**
 * Modal shown after a plan-mode turn completes: ask the user whether to
 * start executing the plan now (the Ink port of the old REPL's
 * inquirer "Execute this plan?" confirm).
 */
export default function PlanConfirmModal({
  taskCount,
  onSelect,
}: PlanConfirmModalProps): React.ReactElement {
  // Default is "Execute" — same default as the old REPL confirm.
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected(selectedRef.current === 0 ? 1 : 0);
    } else if (key.downArrow) {
      setSelected(selectedRef.current === 1 ? 0 : 1);
    } else if (key.return) {
      onSelect(selectedRef.current === 0);
    }
  });

  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  // Fixed height: border (2) + paddingY (2) + title (2, incl. margin) +
  // task line (1) + 2 options + hint (1) = 9 rows.
  const MODAL_HEIGHT = 9;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      position="absolute"
      top={Math.max(1, Math.floor((rows - MODAL_HEIGHT) / 2))}
      left={2}
      width={columns - 4}
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">📋 Plan ready</Text>
      </Box>

      <Text>
        Found {taskCount} pending task{taskCount !== 1 ? 's' : ''}. Execute this plan now?
      </Text>

      <Box>
        <Text color={selected === 0 ? 'cyan' : undefined}>
          {selected === 0 ? '▶ ' : '  '}Yes — start executing
        </Text>
      </Box>
      <Box>
        <Text color={selected === 1 ? 'cyan' : undefined}>
          {selected === 1 ? '▶ ' : '  '}No — stay in plan mode
        </Text>
      </Box>

      <Text dimColor>↑/↓ to navigate, Enter to select</Text>
    </Box>
  );
}
