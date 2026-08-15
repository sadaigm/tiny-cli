import { describe, it, expect } from 'vitest';
import { osc52Sequence, entryClipboardText } from '../src/tui/utils/clipboard.js';

describe('osc52Sequence', () => {
  it('wraps base64 payload in the OSC 52 escape envelope', () => {
    const seq = osc52Sequence('hello');
    expect(seq.startsWith('\x1B]52;c;')).toBe(true);
    expect(seq.endsWith('\x07')).toBe(true);
    const payload = seq.slice('\x1B]52;c;'.length, -1);
    expect(Buffer.from(payload, 'base64').toString('utf-8')).toBe('hello');
  });

  it('round-trips multi-line text with newlines intact', () => {
    const text = 'line one\nline two\n\nline four';
    const seq = osc52Sequence(text);
    const payload = seq.slice('\x1B]52;c;'.length, -1);
    expect(Buffer.from(payload, 'base64').toString('utf-8')).toBe(text);
  });

  it('round-trips non-ASCII characters', () => {
    const text = '🔧 emoji — and ünïcödé';
    const payload = osc52Sequence(text).slice('\x1B]52;c;'.length, -1);
    expect(Buffer.from(payload, 'base64').toString('utf-8')).toBe(text);
  });

  it('strips carriage returns from the payload', () => {
    const payload = osc52Sequence('a\r\nb').slice('\x1B]52;c;'.length, -1);
    expect(Buffer.from(payload, 'base64').toString('utf-8')).toBe('a\nb');
  });

  it('handles empty text', () => {
    expect(Buffer.from(osc52Sequence('').slice('\x1B]52;c;'.length, -1), 'base64').toString()).toBe('');
  });
});

describe('entryClipboardText', () => {
  it('returns tool args for a tool_call', () => {
    expect(
      entryClipboardText({ type: 'tool_call', content: 'write', toolArgs: '{"path":"a.ts"}' }),
    ).toBe('{"path":"a.ts"}');
  });

  it('returns tool result for a tool_result', () => {
    expect(
      entryClipboardText({ type: 'tool_result', content: 'write', toolResult: 'Wrote 3 lines' }),
    ).toBe('Wrote 3 lines');
  });

  it('falls back to content when tool fields are missing', () => {
    expect(entryClipboardText({ type: 'tool_call', content: 'bash' })).toBe('bash');
    expect(entryClipboardText({ type: 'tool_result', content: 'done' })).toBe('done');
  });

  it('returns content for conversational entries', () => {
    expect(entryClipboardText({ type: 'assistant', content: 'here is the answer' })).toBe(
      'here is the answer',
    );
    expect(entryClipboardText({ type: 'user', content: 'question' })).toBe('question');
  });

  it('returns empty string when nothing is set', () => {
    expect(entryClipboardText({ type: 'info' })).toBe('');
  });
});
