import { describe, it, expect } from 'vitest';
import { summarizeToolCall, summarizeToolResult, wrapIndent } from '../src/tui/utils/toolSummary.js';
import type { LogEntry } from '../src/tui/state.js';

/** Build a minimal tool_call LogEntry for a given tool + args JSON. */
function call(toolName: string, args: object): LogEntry {
  return {
    id: 'log-1',
    type: 'tool_call',
    content: '',
    toolName,
    toolArgs: JSON.stringify(args),
    timestamp: 0,
  };
}

describe('summarizeToolCall — per-tool meaningful field', () => {
  const COLS = 100;

  it('write: shows basename + hidden line count, hides content in header', () => {
    const entry = call('write', {
      path: '/abs/path/to/src/foo.ts',
      content: 'line1\nline2\nline3\nline4',
    });
    const s = summarizeToolCall(entry, COLS);
    expect(s.header).toBe('write  foo.ts  ⤤ +4 lines');
    // Content must NOT appear in the one-line header.
    expect(s.header).not.toContain('line1');
    expect(s.hiddenLineCount).toBe(4);
    expect(s.detail).toContain('line1');
  });

  it('read: shows basename, first250 flag', () => {
    const entry = call('read', { path: 'src/foo.ts', first250: true });
    expect(summarizeToolCall(entry, COLS).header).toBe('read  foo.ts · first250');
  });

  it('read: shows basename only when no range flags', () => {
    const entry = call('read', { path: 'README.md' });
    expect(summarizeToolCall(entry, COLS).header).toBe('read  README.md');
  });

  it('bash: shows the command with $ prefix', () => {
    const entry = call('bash', { cmd: 'npm run build' });
    expect(summarizeToolCall(entry, COLS).header).toBe('bash  $ npm run build');
  });

  it('grep: shows pattern + path basename', () => {
    const entry = call('grep', { pattern: 'TODO', path: 'src' });
    expect(summarizeToolCall(entry, COLS).header).toBe('grep  TODO  in src');
  });

  it('glob: shows the pattern', () => {
    const entry = call('glob', { pattern: 'src/**/*.ts' });
    expect(summarizeToolCall(entry, COLS).header).toBe('glob  src/**/*.ts');
  });

  it('list: shows the path', () => {
    const entry = call('list', { path: 'src/components' });
    expect(summarizeToolCall(entry, COLS).header).toBe('list  src/components');
  });

  it('search_replace: shows basename + first line of search', () => {
    const entry = call('search_replace', {
      path: 'src/foo.ts',
      search: 'old line one\nold line two',
      replace: 'new line',
    });
    const header = summarizeToolCall(entry, COLS).header;
    expect(header).toContain('search_replace  foo.ts');
    expect(header).toContain('old line one');
  });

  it('insert_lines: shows basename + line number', () => {
    const entry = call('insert_lines', { path: 'src/foo.ts', line: 42, content: 'x' });
    expect(summarizeToolCall(entry, COLS).header).toBe('insert_lines  foo.ts @42');
  });

  it('unknown tool: falls back to a capped raw representation', () => {
    const entry = call('mystery_tool', { a: 1, b: 2 });
    const s = summarizeToolCall(entry, COLS);
    expect(s.header).toContain('mystery_tool');
    expect(s.header.length).toBeLessThanOrEqual(COLS);
  });
});

describe('summarizeToolCall — defensive parsing', () => {
  it('survives invalid JSON args without throwing', () => {
    const entry: LogEntry = {
      id: 'log-2',
      type: 'tool_call',
      content: '',
      toolName: 'write',
      toolArgs: '{ this is not json',
      timestamp: 0,
    };
    const s = summarizeToolCall(entry, 80);
    // Falls back to a raw, capped representation; never throws.
    expect(s.header).toContain('write');
    expect(s.header.length).toBeLessThanOrEqual(80);
  });

  it('survives missing args entirely', () => {
    const entry: LogEntry = {
      id: 'log-3',
      type: 'tool_call',
      content: '',
      toolName: 'write',
      timestamp: 0,
    };
    const s = summarizeToolCall(entry, 80);
    expect(s.header).toContain('<no path>');
  });

  it('caps long headers to the given width', () => {
    const longPath = 'x'.repeat(200);
    const entry = call('write', { path: longPath, content: '' });
    expect(summarizeToolCall(entry, 40).header.length).toBeLessThanOrEqual(42);
  });
});

describe('summarizeToolResult', () => {
  it('shows the first line of the result and counts hidden lines', () => {
    const entry: LogEntry = {
      id: 'log-4',
      type: 'tool_result',
      content: '',
      toolResult: 'first line\nsecond line\nthird line',
      timestamp: 0,
    };
    const s = summarizeToolResult(entry, 100);
    expect(s.header).toBe('↳ first line');
    expect(s.hiddenLineCount).toBe(3);
    expect(s.detail).toContain('second line');
  });

  it('handles empty results', () => {
    const entry: LogEntry = { id: 'log-5', type: 'tool_result', content: '', timestamp: 0 };
    const s = summarizeToolResult(entry, 80);
    expect(s.header).toBe('↳ ');
    expect(s.hiddenLineCount).toBe(0);
  });
});

describe('wrapIndent', () => {
  it('indents short lines without wrapping', () => {
    expect(wrapIndent('hello', 2, 80)).toBe('  hello');
  });

  it('wraps long lines at width - indent and indents each chunk', () => {
    const out = wrapIndent('abcdefghij', 2, 7); // usable = 5 → two chunks of 5
    expect(out).toBe('  abcde\n  fghij');
  });

  it('preserves existing newlines', () => {
    expect(wrapIndent('a\nb', 1, 80)).toBe(' a\n b');
  });

  it('still wraps at a very narrow width (each chunk = usable)', () => {
    // width=5, indent=2 → usable=3 → 20 chars → 7 chunks (20/3).
    const out = wrapIndent('x'.repeat(20), 2, 5);
    expect(out.split('\n').length).toBe(7);
  });
});
