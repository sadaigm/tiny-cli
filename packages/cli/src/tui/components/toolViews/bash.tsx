/**
 * ShellOutputView — `bash`.
 *
 * Call entry: `$ <cmd>` (accent-ish, plain color).
 * Result entry: merged stdout+stderr as plain lines. NOTE: the core runner
 * (tools/definitions.ts bash handler) merges streams and drops the exit code,
 * so the planned `exit N` row / red stderr need a core change first — v1
 * renders the merged output plainly.
 */
import type { ToolView } from './index.js';
import { parseArgs, wrapIndent } from '../../utils/toolSummary.js';

export const bashView: ToolView = {
  body(entry, columns) {
    const usable = columns - 3;
    if (entry.type === 'tool_call') {
      const cmd = parseArgs(entry.toolArgs)?.cmd;
      if (typeof cmd !== 'string' || !cmd.trim()) return [];
      return wrapIndent(`$ ${cmd}`, 0, usable).split('\n').map((text) => ({ text }));
    }
    const out = (entry.toolResult ?? '').trim();
    if (!out) return [{ text: '(no output)', dim: true }];
    return wrapIndent(out, 0, usable).split('\n').map((text) => ({ text }));
  },
};
