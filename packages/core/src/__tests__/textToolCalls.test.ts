import { extractTextToolCalls } from '../agent/textToolCalls.js';
import { ToolDefinition } from '../types.js';

const tools: ToolDefinition[] = [
  {
    name: 'write',
    description: 'Write text content to a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

// Byte-exact shape captured from Qwen3.8-4bit drift in tui.log.
const xmlCall = (name: string, params: Record<string, string>): string =>
  '<tool_call>\n' +
  `<function=${name}>\n` +
  Object.entries(params)
    .map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>`)
    .join('\n') +
  '\n</function>\n</tool_call>';

describe('extractTextToolCalls — JSON shape (regression)', () => {
  it('promotes a whole-message JSON tool call', () => {
    const calls = extractTextToolCalls(
      '{"name":"bash","arguments":{"command":"ls -la"}}',
      tools,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('bash');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: 'ls -la' });
  });

  it('ignores JSON embedded mid-prose', () => {
    expect(
      extractTextToolCalls('Here is the call: {"name":"bash","arguments":{"command":"ls"}}', tools),
    ).toEqual([]);
  });
});

describe('extractTextToolCalls — pseudo-XML shape', () => {
  it('promotes a complete call and preserves multi-line content byte-for-byte', () => {
    const content = '# AI OS — Design Document\n\n```mermaid\nflowchart TB\n    A --> B\n```\n';
    const calls = extractTextToolCalls(
      xmlCall('write', { path: 'ai_os_design.md', content }),
      tools,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('write');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      path: 'ai_os_design.md',
      content,
    });
  });

  it('promotes a call preceded by narration prose (observed drift shape)', () => {
    const calls = extractTextToolCalls(
      "I have the full PRD context. Now I'll create the design document.\n\n" +
        xmlCall('write', { path: 'hello.md', content: '# Hello' }),
      tools,
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      path: 'hello.md',
      content: '# Hello',
    });
  });

  it('rejects a truncated call (no closing tag) so a half-written file never executes', () => {
    const truncated =
      '<tool_call>\n<function=write>\n<parameter=path>\nai_os_design.md\n</parameter>\n' +
      '<parameter=content>\n# only half the file — cut off by the token limit';
    expect(extractTextToolCalls(truncated, tools)).toEqual([]);
  });

  it('rejects an unknown function name', () => {
    expect(extractTextToolCalls(xmlCall('delete_everything', { path: '/' }), tools)).toEqual([]);
  });

  it('rejects parameters outside the tool schema', () => {
    expect(
      extractTextToolCalls(xmlCall('write', { path: 'a.md', mode: 'overwrite', content: 'x' }), tools),
    ).toEqual([]);
  });

  it('extracts multiple calls from one message', () => {
    const calls = extractTextToolCalls(
      xmlCall('write', { path: 'a.md', content: 'A' }) + '\n' +
        xmlCall('bash', { command: 'cat a.md' }),
      tools,
    );
    expect(calls.map(c => c.function.name)).toEqual(['write', 'bash']);
  });

  it('strips exactly one template newline around values, keeping interior whitespace', () => {
    const calls = extractTextToolCalls(
      xmlCall('write', { path: 'a.md', content: 'keep  trailing spaces  \n\nand blank lines\n' }),
      tools,
    );
    expect(JSON.parse(calls[0].function.arguments).content).toBe(
      'keep  trailing spaces  \n\nand blank lines\n',
    );
  });
});

describe('extractTextToolCalls — pass-through', () => {
  it('leaves ordinary prose untouched', () => {
    expect(extractTextToolCalls('The design looks good — no tool call here.', tools)).toEqual([]);
  });

  it('leaves prose that merely mentions tool syntax with no valid block', () => {
    expect(extractTextToolCalls('Use <tool_call> blocks when calling tools.', tools)).toEqual([]);
  });
});
