import React from 'react';
import { Box, Text } from '../compat.js';
import { basename } from 'node:path';
import { DEFAULT_COMPACT_THRESHOLD } from '@tiny-cli/core';
import type { TuiMode, ContextStats } from '../state.js';
import { getTheme } from '../theme.js';

/**
 * Props for the {@link StatusBar} component.
 */
export interface StatusBarProps {
  /** Current execution mode (agent / chat / plan). */
  mode: TuiMode;
  /** Context window statistics (token count and total characters). */
  contextStats: ContextStats;
  /** Current permission mode governing tool-call approval. */
  permissionMode: 'notify' | 'auto-edit' | 'auto';
  /**
   * Token budget the meter fills against — the configured compaction
   * threshold (`compactionThresholdTokens`), falling back to the core
   * default when unset.
   */
  compactThreshold?: number;
  /** Working directory — only the folder name is shown. */
  cwd: string;
  /** Current reasoning effort level; unset means off (no thinking param sent). */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
}

/**
 * Formats a character count into a human-readable size string.
 *
 * @param chars - Total character count.
 * @returns e.g. `"1.2 KB"`, `"850 B"`.
 */
function formatBytes(chars: number): string {
  if (chars < 1024) {
    return `${chars} B`;
  }
  return `${(chars / 1024).toFixed(1)} KB`;
}

/**
 * Formats a token count with thousands separators.
 *
 * @param tokens - Total token count.
 * @returns e.g. `"4,200"`.
 */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

/** Human-readable labels for each permission mode. */
const PERMISSION_LABELS: Record<StatusBarProps['permissionMode'], string> = {
  notify: 'notify',
  'auto-edit': 'auto-edit',
  auto: 'auto',
};

/**
 * One-line usage meter: a 10-slot bar plus percent of the compaction
 * threshold. Colour ramps green → yellow (≥60%) → red (≥85%) so the
 * approach to compaction is visible at a glance.
 */
function usageMeter(tokens: number, threshold: number): { bar: string; percent: number; color: string } {
  const fraction = Math.min(1, tokens / threshold);
  const filled = Math.round(fraction * 10);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  return {
    bar,
    percent: Math.round(fraction * 100),
    color: fraction >= 0.85 ? 'red' : fraction >= 0.6 ? 'yellow' : 'green',
  };
}

/**
 * Renders a single-line status bar showing the current mode, context
 * window usage (tokens and characters), and the active permission mode.
 *
 * This component is purely presentational — it reflects props derived
 * from the global {@link TuiState} and does not manage any state of its
 * own.
 *
 * @example
 * ```tsx
 * <StatusBar mode={state.mode} contextStats={state.contextStats} permissionMode="notify" />
 * ```
 */
function StatusBar({ mode, contextStats, permissionMode, compactThreshold = DEFAULT_COMPACT_THRESHOLD, cwd, thinkingLevel = 'off' }: StatusBarProps): React.ReactNode {
  // Token counts come from the model tokenizer's encoding (cl100k_base via
  // agent.getContextStats), not a chars/4 estimate — the meter is the real
  // budget the auto-compaction threshold acts on.
  const meter = usageMeter(contextStats.tokens, compactThreshold);
  const theme = getTheme();
  return (
    // Left-packed single row — no space-between, so no full-width stretching gap.
    <Box>
      <Text color={theme.accent} bold>
        [{mode}]
      </Text>
      <Text>  </Text>
      <Text color={theme.system}>📁 {basename(cwd)}</Text>
      <Text>  </Text>
      <Text color={theme.system}>
        🧠 {formatTokens(contextStats.tokens)} tok{' '}
      </Text>
      <Text color={meter.color}>
        {meter.bar} {meter.percent}%
      </Text>
      <Text color={theme.system}> ({formatBytes(contextStats.characters)})</Text>
      <Text>  </Text>
      <Text color={theme.system}>🔒 {PERMISSION_LABELS[permissionMode]}</Text>
      <Text>  </Text>
      <Text color={thinkingLevel === 'off' ? theme.system : theme.accent}>✦ thinking: {thinkingLevel}</Text>
    </Box>
  );
}

// Memoize so StatusBar skips re-render when App re-renders for an unrelated
// reason (e.g. mentionActive flipping) and mode/tokens/permission are unchanged.
export default React.memo(StatusBar);
