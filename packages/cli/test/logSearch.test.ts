import { describe, it, expect } from 'vitest';
import { findInLog } from '../src/tui/utils/logSearch.js';
import type { LogEntry } from '../src/tui/utils/logSearch.js';

/** Build a minimal LogEntry for tests. */
function entry(id: string, type: LogEntry['type'], content: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { id, type, content, timestamp: 0, ...extra } as LogEntry;
}

describe('findInLog', () => {
  const entries: LogEntry[] = [
    entry('1', 'user', 'fix the login bug'),
    entry('2', 'assistant', 'I will look at src/auth.ts'),
    entry('3', 'tool_call', '', { toolName: 'write', toolArgs: '{"path": "src/auth.ts"}' }),
    entry('4', 'tool_result', 'Wrote 24 lines'),
    entry('5', 'assistant', 'the bug was a stale session cookie'),
    entry('6', 'user', 'thanks, ship it'),
  ];

  it('finds matches in message content', () => {
    const hits = findInLog(entries, 'bug');
    expect(hits.map((h) => h.id)).toEqual(['5', '1']);
  });

  it('returns newest-first with 1-based ranks', () => {
    const hits = findInLog(entries, 'bug');
    expect(hits[0].matchNumber).toBe(1);
    expect(hits[0].index).toBe(4);
    expect(hits[0].matchCount).toBe(2);
    expect(hits[1].matchNumber).toBe(2);
    expect(hits[1].index).toBe(0);
  });

  it('matches case-insensitively', () => {
    expect(findInLog(entries, 'LOGIN')?.[0]?.id).toBe('1');
    expect(findInLog(entries, 'Ship IT')?.[0]?.id).toBe('6');
  });

  it('searches tool name and args, not just content', () => {
    const hits = findInLog(entries, 'auth.ts');
    // Assistant mention + the write tool call that touched the file.
    expect(hits.map((h) => h.id)).toEqual(['3', '2']);
    // Tool hits preview as the tool name.
    expect(hits[0].preview).toBe('write');
  });

  it('previews the first non-empty line of multi-line content', () => {
    const multi = [entry('a', 'assistant', 'first line\nsecond line with needle')];
    expect(findInLog(multi, 'needle')[0].preview).toBe('first line');
  });

  it('caps the preview length', () => {
    const long = [entry('a', 'user', 'x'.repeat(500) + ' needle')];
    const hit = findInLog(long, 'needle')[0];
    expect(hit.preview.length).toBe(120);
  });

  it('returns empty for no matches, empty and whitespace queries', () => {
    expect(findInLog(entries, 'deploy')).toEqual([]);
    expect(findInLog(entries, '')).toEqual([]);
    expect(findInLog(entries, '   ')).toEqual([]);
  });

  it('reports entry type for result labelling', () => {
    const hits = findInLog(entries, 'auth.ts');
    expect(hits[0].type).toBe('tool_call');
    expect(hits[1].type).toBe('assistant');
  });

  it('handles an empty log', () => {
    expect(findInLog([], 'anything')).toEqual([]);
  });

  it('skips blank leading lines when previewing', () => {
    const blank = [entry('a', 'assistant', '\n\nactual output with needle')];
    expect(findInLog(blank, 'needle')[0].preview).toBe('actual output with needle');
  });

  it('searches tool_result output via toolResult field', () => {
    const results = [entry('r', 'tool_result', '', { toolName: 'bash', toolResult: 'exit code 1\nneedle here' })];
    const hits = findInLog(results, 'needle');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('r');
    // Tool entries preview as the tool name (content is empty).
    expect(hits[0].preview).toBe('bash');
  });
});
