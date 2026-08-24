// model/client.ts imports node-fetch (ESM-only) — stub it so the CommonJS
// Jest transform can load the module graph.
jest.mock('node-fetch', () => ({ default: jest.fn() }));
// @tiny-cli/resources ships ESM-only — stub its skill loader too.
jest.mock('@tiny-cli/resources', () => ({
  loadSkills: jest.fn().mockResolvedValue({ skills: [], warnings: [] }),
  renderSkillsXml: jest.fn().mockReturnValue(''),
}));

import { Agent } from '../agent.js';
import { Message } from '../types.js';

/**
 * Runtime access to Agent internals (model/registry/messages) so we can
 * script model responses without network access.
 */
function makeAgent(config: Record<string, unknown>): any {
  const agent = new Agent({
    endpoint: 'http://localhost:1',
    apiKey: 'test',
    model: 'test-model',
    ...config,
  });
  (agent as any).model.chat = jest.fn();
  return agent;
}

/** Tool-call response the model returns for round n (unique args per round
 *  so the in-turn redundancy dedupe doesn't block them). */
function toolCallResponse(id: string): Message & { tool_calls: unknown[] } {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id, type: 'function', function: { name: 'read', arguments: `{"path":"a${id}.txt"}` } },
    ],
  } as any;
}

describe('Agent compaction boundaries & callbacks', () => {
  it('onHistoryChange fires once per appended message', async () => {
    const agent = makeAgent({});
    agent.registry.getDefinitions = () => [];
    let changes = 0;
    agent.onHistoryChange = () => { changes++; };

    agent.model.chat.mockResolvedValue({ content: 'done', tool_calls: undefined });
    await agent.run('hello');

    // system unshift + user push happen before the model call; the assistant
    // push adds one more notification. Tool-result pushes add none here.
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('compacts at turn start and keeps the new user message intact', async () => {
    const agent = makeAgent({ compactionThresholdTokens: 200, compactionRetainTokens: 50 });
    agent.registry.getDefinitions = () => [];
    agent.setHistory([
      { role: 'user', content: 'x '.repeat(400) },
      { role: 'assistant', content: 'y '.repeat(400) },
    ]);

    let compacted: [number, number] | null = null;
    agent.onCompaction = (before: number, after: number) => { compacted = [before, after]; };

    // 1st chat call = summary request, 2nd = the actual turn (final answer).
    agent.model.chat
      .mockResolvedValueOnce({ content: 'SUMMARY', tool_calls: undefined })
      .mockResolvedValueOnce({ content: 'final answer', tool_calls: undefined });

    await agent.run('fresh question', undefined, 'agent', true);

    expect(compacted).not.toBeNull();
    const msgs = agent.getMessages();
    expect(msgs.some((m: Message) => m.role === 'user' && m.content === 'fresh question')).toBe(true);
    expect(msgs.some((m: Message) => m.content.includes('[PREVIOUS CONTEXT SUMMARY]'))).toBe(true);
    expect(msgs.some((m: Message) => m.role === 'assistant' && m.content === 'final answer')).toBe(true);
  });

  it('fires mid-turn compaction exactly at the 10th tool call when over threshold', async () => {
    const agent = makeAgent({ compactionThresholdTokens: 500, compactionRetainTokens: 100 });
    agent.registry.getDefinitions = () => [];
    agent.registry.call = jest.fn().mockResolvedValue('result '.repeat(40));
    const compactions: number[] = [];
    agent.onCompaction = () => { compactions.push(1); };

    // Script: 10 rounds each with one tool call, then a final answer.
    const responses: any[] = [];
    for (let i = 0; i < 10; i++) responses.push(toolCallResponse(`c${i}`));
    responses.push({ content: 'all done', tool_calls: undefined });
    // Compaction's summary request arrives mid-script — detect it by prompt.
    agent.model.chat.mockImplementation((messages: Message[]) => {
      const last = messages[messages.length - 1];
      if (last?.content?.startsWith('Summarize the following')) {
        return Promise.resolve({ content: 'SUMMARY', tool_calls: undefined });
      }
      return Promise.resolve(responses.shift());
    });

    await agent.run('do the things');

    expect(agent.registry.call).toHaveBeenCalledTimes(10);
    expect(compactions.length).toBe(1);
    // Final answer survived.
    expect(agent.getMessages().some((m: Message) => m.role === 'assistant' && m.content === 'all done')).toBe(true);
  });

  it('does not compact mid-turn when under threshold', async () => {
    const agent = makeAgent({});
    agent.registry.getDefinitions = () => [];
    agent.registry.call = jest.fn().mockResolvedValue('ok');
    const compactions: number[] = [];
    agent.onCompaction = () => { compactions.push(1); };

    const responses: any[] = [];
    for (let i = 0; i < 10; i++) responses.push(toolCallResponse(`c${i}`));
    responses.push({ content: 'done', tool_calls: undefined });
    agent.model.chat.mockImplementation((messages: Message[]) => {
      const last = messages[messages.length - 1];
      if (last?.content?.startsWith('Summarize the following')) {
        return Promise.resolve({ content: 'SUMMARY', tool_calls: undefined });
      }
      return Promise.resolve(responses.shift());
    });

    await agent.run('small task');
    expect(compactions.length).toBe(0);
  });
});
