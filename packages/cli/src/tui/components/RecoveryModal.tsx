import React, { useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from '../compat.js';
import type { PendingRecovery } from '../state.js';
import type { RecoveryChoice } from '../hooks/useAgent.js';

interface RecoveryModalProps {
  recovery: PendingRecovery;
  onSelect: (choice: RecoveryChoice) => void;
}

const OPTIONS: { key: RecoveryChoice; label: string; desc: string }[] = [
  { key: 'retry', label: 'Retry', desc: 'Re-run this task' },
  { key: 'manual', label: 'Manual', desc: 'Mark as done manually' },
  { key: 'skip', label: 'Skip', desc: 'Skip to the next task' },
  { key: 'stop', label: 'Stop', desc: 'Abort plan execution' },
];

export default function RecoveryModal({ recovery, onSelect }: RecoveryModalProps): React.ReactElement {
  const [selected, setSelected] = useState(0);
  // Mirror of `selected` for synchronous reads: when ↓↓ + Enter arrive in
  // one stdin chunk (fast typing / test scripts), the useInput callback
  // runs before React re-renders, so the closure's `selected` is stale.
  const selectedRef = useRef(0);
  selectedRef.current = selected;

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected(selectedRef.current === 0 ? OPTIONS.length - 1 : selectedRef.current - 1);
    } else if (key.downArrow) {
      setSelected(selectedRef.current === OPTIONS.length - 1 ? 0 : selectedRef.current + 1);
    } else if (key.return) {
      onSelect(OPTIONS[selectedRef.current].key);
    }
  });

  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  // Fixed height: border (2) + paddingY (2) + title (2, incl. margin) +
  // task line (2, incl. margin) + 4 options + hint (1) = 13 rows.
  const MODAL_HEIGHT = 13;

  return (
    // Absolute overlay: floats over the conversation without reserving
    // rows or reflowing the layout (same approach as ApprovalModal).
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      position="absolute"
      top={Math.max(1, Math.floor((rows - MODAL_HEIGHT) / 2))}
      left={2}
      width={columns - 4}
    >
      <Box marginBottom={1}>
        <Text bold color="yellow">⚠ Task not marked complete</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Task {recovery.taskIndex + 1}/{recovery.totalTasks}: </Text>
        {/* wrap="truncate" keeps the task on one line so the modal's fixed
            height (and the centering math above) stays valid. */}
        <Text dimColor wrap="truncate">{recovery.taskText}</Text>
      </Box>

      {OPTIONS.map((opt, i) => (
        <Box key={opt.key}>
          <Text color={i === selected ? 'cyan' : undefined}>
            {i === selected ? '▶ ' : '  '}
            {opt.label}
          </Text>
          <Text dimColor> — {opt.desc}</Text>
        </Box>
      ))}

      <Text dimColor>↑/↓ to navigate, Enter to select</Text>
    </Box>
  );
}
