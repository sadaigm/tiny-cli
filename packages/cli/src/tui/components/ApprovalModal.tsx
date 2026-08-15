import React, { useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ToolCall } from '@tiny-cli/core';
import type { ApprovalChoice } from '../hooks/useAgent.js';
import { summarizeToolCall } from '../utils/toolSummary.js';
import type { LogEntry } from '../state.js';

/**
 * Props for the {@link ApprovalModal} component.
 */
export interface ApprovalModalProps {
  /** The pending tool call awaiting user decision. */
  toolCall: ToolCall;
  /** Called when the user selects an action. Resolves the deferred promise. */
  onSelect: (choice: ApprovalChoice) => void;
}

/** Button definitions: key, label, shortcut key, color. */
const BUTTONS: { key: ApprovalChoice; label: string; shortcut: string; color: string }[] = [
  { key: 'approve', label: 'Approve', shortcut: 'y', color: 'green' },
  { key: 'approve-session', label: 'Approve for session', shortcut: 's', color: 'cyan' },
  { key: 'cancel', label: 'Cancel', shortcut: 'n', color: 'yellow' },
  { key: 'abort', label: 'Abort', shortcut: 'a', color: 'red' },
];

/**
 * Modal overlay that asks the user to approve a pending tool call.
 *
 * Rendered when `state.pendingApproval` is non-null.  Displays the tool
 * name and its arguments (pretty-printed JSON), then a horizontal row
 * of buttons.  Navigation via:
 *
 * - **← / →** or **Tab** — move between buttons
 * - **Enter** — select highlighted button
 * - **y** / **s** / **n** / **a** — quick-select a specific option
 * - **Escape** — same as Cancel
 *
 * On selection, calls `onSelect(choice)` which resolves the deferred
 * promise in `useAgent`, unblocking `agent.run()`.
 *
 * @example
 * ```tsx
 * {state.pendingApproval ? (
 *   <ApprovalModal toolCall={state.pendingApproval} onSelect={agentApi.resolveApproval} />
 * ) : null}
 * ```
 */
export default function ApprovalModal({
  toolCall,
  onSelect,
}: ApprovalModalProps): React.ReactElement {
  const [highlighted, setHighlighted] = useState(0);
  // Mirror for synchronous reads: arrow keys and Enter can arrive in one
  // stdin chunk before React re-renders, leaving the closure's
  // `highlighted` stale. The ref always holds the freshest value.
  const highlightedRef = useRef(0);
  highlightedRef.current = highlighted;

  useInput((input, key) => {
    // Quick-select shortcuts
    const lower = input.toLowerCase();
    const shortcutIdx = BUTTONS.findIndex((b) => b.shortcut === lower);
    if (shortcutIdx !== -1) {
      onSelect(BUTTONS[shortcutIdx].key);
      return;
    }

    // Escape = Cancel
    if (key.escape) {
      onSelect('cancel');
      return;
    }

    // Arrow / Tab navigation
    if (key.leftArrow || (input === ' ' && key.tab)) {
      setHighlighted((prev) => (prev - 1 + BUTTONS.length) % BUTTONS.length);
      return;
    }
    if (key.rightArrow || key.tab) {
      setHighlighted((prev) => (prev + 1) % BUTTONS.length);
      return;
    }

    // Enter selects highlighted
    if (key.return) {
      onSelect(BUTTONS[highlightedRef.current].key);
      return;
    }
  });

  // Summarize the tool call the same way the message log does — one compact
  // line showing the meaningful field (path/cmd/pattern), not a raw 500-char
  // JSON blob that would wrap and break the modal layout.
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const summary = summarizeToolCall(
    {
      id: 'approval',
      type: 'tool_call',
      content: '',
      toolName: toolCall.function.name,
      toolArgs: toolCall.function.arguments,
      timestamp: 0,
    } as LogEntry,
    columns,
  );
  // A short, single-line arg preview (first line only, capped).
  const argPreview = summary.detail
    ? summary.detail.split('\n').filter((l) => l.trim())[0]?.slice(0, columns - 8) ?? ''
    : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⚠  Tool Approval Required
      </Text>

      <Box>
        <Text color="blue">🔧 </Text>
        <Text bold>{summary.header}</Text>
      </Box>

      {argPreview ? (
        <Box marginLeft={2}>
          <Text dimColor color="gray">
            {argPreview}
          </Text>
        </Box>
      ) : null}

      {/* Button row — fixed single line, each button a stable cell */}
      <Box marginTop={1}>
        {BUTTONS.map((btn, i) => (
          <React.Fragment key={btn.key}>
            {i === highlighted ? (
              <Text backgroundColor={btn.color} color="black" bold>
                {' '}
                {btn.label} ({btn.shortcut.toUpperCase()}){' '}
              </Text>
            ) : (
              <Text color={btn.color}>
                {' '}
                [{btn.shortcut.toUpperCase()}] {btn.label}{' '}
              </Text>
            )}
          </React.Fragment>
        ))}
      </Box>

      <Text dimColor>←/→ navigate · Enter confirm · Esc cancel</Text>
    </Box>
  );
}
