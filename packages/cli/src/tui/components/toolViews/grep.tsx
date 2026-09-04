/**
 * SearchResultsView — `grep`.
 *
 * Call entry: `/pattern/ in <path>` meta line.
 * Result entry: `N matches · M files` meta row, then per file a dim path
 * header with one `  <line>: <text>` row per match (text truncated to the
 * width, one visual line per match — keeps the estimator trivial).
 */
import type { ToolView, SpecLine } from './index.js';
import { parseArgs, wrapIndent } from '../../utils/toolSummary.js';

const MAX_MATCH_ROWS = 50;

export const grepView: ToolView = {
  body(entry, columns) {
    const usable = Math.max(20, columns - 3);
    if (entry.type === 'tool_call') {
      const args = parseArgs(entry.toolArgs);
      const head = `/${String(args?.pattern ?? '')}/`;
      const scope = args?.path ? ` in ${String(args.path)}` : ' in project';
      return wrapIndent(head + scope, 0, usable).split('\n').map((text) => ({ text, dim: true }));
    }

    const out = (entry.toolResult ?? '').trim();
    if (!out || out === 'No matches found.') return [{ text: 'No matches', dim: true }];

    // Result lines are `path:line:text` (core grep handler format).
    const groups = new Map<string, { line: string; text: string }[]>();
    for (const raw of out.split('\n')) {
      const m = raw.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const list = groups.get(m[1]) ?? [];
      list.push({ line: m[2], text: m[3] });
      groups.set(m[1], list);
    }
    const matches = [...groups.values()].reduce((n, g) => n + g.length, 0);
    if (matches === 0) return wrapIndent(out, 0, usable).split('\n').map((text) => ({ text }));

    const lines: SpecLine[] = [{ text: `${matches} matches · ${groups.size} files`, dim: true }];
    let shown = 0;
    for (const [path, hits] of groups) {
      if (shown >= MAX_MATCH_ROWS) break;
      lines.push({ text: path, dim: true });
      for (const hit of hits) {
        if (shown >= MAX_MATCH_ROWS) break;
        shown++;
        const prefix = `  ${hit.line}: `;
        lines.push({ text: prefix + hit.text.slice(0, Math.max(1, usable - prefix.length)) });
      }
    }
    if (matches > shown) lines.push({ text: `… +${matches - shown} more (y to copy all)`, dim: true });
    return lines;
  },
};
