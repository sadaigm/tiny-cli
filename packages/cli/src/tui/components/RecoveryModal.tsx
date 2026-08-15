import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">⚠ Task not marked complete</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Task {recovery.taskIndex + 1}/{recovery.totalTasks}: </Text>
        <Text dimColor>{recovery.taskText}</Text>
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
