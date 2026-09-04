import React, { useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from '../compat.js';
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
  const rows = stdout?.rows ?? 24;
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
  // Preview of the args (first non-empty lines, Ink-wrapped). The modal is
  // anchored at the top and grows downward, so the preview budget is
  // whatever rows remain after the fixed chrome (title, tool header,
  // optional path, buttons, hint, 2 border rows, top offset).
  const FIXED_ROWS = 8;
  const top = 2;
  const previewBudget = Math.max(0, rows - top - FIXED_ROWS);
  const previewLines = summary.detail
    ? summary.detail.split('\n').filter((l) => l.trim()).slice(0, previewBudget)
    : [];
  // The full target path (if any) on its own line — never truncated mid-word
  // by the width budget; Ink wraps it instead.
  let fullPath = '';
  try {
    const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    if (typeof args.path === 'string') fullPath = args.path;
    else if (typeof args.cmd === 'string') fullPath = args.cmd;
  } catch {
    // args not JSON — leave fullPath empty
  }

  return (
    // Absolute overlay: taken out of the flex flow so it floats over the
    // conversation without reserving rows or reflowing the layout.
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      backgroundColor="black"
      paddingX={1}
      position="absolute"
      top={top}
      left={2}
      width={columns - 4}
    >
      <Text color="yellow" bold>
        ⚠  Tool Approval Required
      </Text>

      <Box>
        <Text color="blue">🔧 </Text>
        <Text bold>{summary.header}</Text>
      </Box>

      {previewLines.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {previewLines.map((line, i) => (
            <Text key={i} dimColor color="gray" wrap="wrap">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {fullPath ? (
        <Box marginLeft={2}>
          <Text color="gray" wrap="wrap">
            {fullPath}
          </Text>
        </Box>
      ) : null}

      {/* Button row — fixed single line, each button a stable cell */}
      <Box marginTop={1}>
        {BUTTONS.map((btn, i) =>
          i === highlighted ? (
            <Text key={btn.key} backgroundColor={btn.color} color="black" bold>
              {' '}
              {btn.label} ({btn.shortcut.toUpperCase()}){' '}
            </Text>
          ) : (
            <Text key={btn.key} color={btn.color}>
              {' '}
              [{btn.shortcut.toUpperCase()}] {btn.label}{' '}
            </Text>
          ),
        )}
      </Box>

      <Text dimColor>←/→ navigate · Enter confirm · Esc cancel</Text>
    </Box>
  );
}
