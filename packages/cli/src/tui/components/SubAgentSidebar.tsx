import React from 'react';
import { Box, Text } from '../compat.js';
import type { SubAgentSummary } from '@tiny-cli/core';
import type { ActiveAgentTarget } from '../state.js';
import { getTheme } from '../theme.js';

export interface SubAgentSidebarProps {
  statuses: SubAgentSummary[];
  activeTarget?: ActiveAgentTarget;
  width?: number;
  /** Fixed panel height — matches the conversation pane so borders align. */
  height?: number;
  /** Panel owns the keyboard (Ctrl+G mode): highlight selection, show kill hints. */
  focused?: boolean;
  /** Index of the highlighted row while focused. */
  selectedIndex?: number;
}

function statusBadge(status: SubAgentSummary['status']): { icon: string; label: string; color: string } {
  switch (status) {
    case 'running':
      return { icon: '⏳', label: 'working', color: 'yellow' };
    case 'completed':
      return { icon: '✅', label: 'done', color: 'green' };
    case 'failed':
      return { icon: '❌', label: 'failed', color: 'red' };
    case 'cancelled':
      return { icon: '🚫', label: 'cancelled', color: 'gray' };
    case 'waiting_mentor':
      return { icon: '🔄', label: 'waiting', color: 'magenta' };
    case 'idle':
    default:
      return { icon: '⚪', label: 'idle', color: 'gray' };
  }
}

export default function SubAgentSidebar({
  statuses,
  activeTarget,
  width = 28,
  height,
  focused = false,
  selectedIndex = 0,
}: SubAgentSidebarProps): React.ReactNode {
  const theme = getTheme();

  if (statuses.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      paddingY={0}
      overflow="hidden"
    >
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>
          Sub-Agents ({statuses.length})
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {statuses.map((s, index) => {
          const isCurrent = activeTarget?.kind === 'sub' && activeTarget.id === s.id;
          const isSelected = focused && index === selectedIndex;
          const badge = statusBadge(s.status);

          return (
            <Box key={s.id} height={1}>
              {/* One line: name + status — keep entries compact so several
                sub-agents fit the fixed panel height. */}
              <Text>
                <Text
                  color={isSelected ? 'green' : isCurrent ? 'cyan' : theme.assistant}
                  inverse={isSelected}
                  wrap="truncate"
                >
                  {isSelected || isCurrent ? '▶' : ' '} {s.name}
                </Text>
                <Text color={badge.color}> {badge.icon}</Text>
                <Text dimColor wrap="truncate">
                  {' '}
                  {s.id}
                  {s.currentTool ? ` · 🔧${s.currentTool}` : ''}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={0}>
        <Text dimColor italic>
          {focused ? '↑/↓ select · Ctrl+X kill · a kill-all · Esc back' : '/sub [id] to view'}
        </Text>
      </Box>
    </Box>
  );
}

