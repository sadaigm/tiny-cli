import { ToolRegistry } from '../tools/registry';
import { registerDefaultTools } from '../tools/definitions';
import { classifyLockKey, ASK_USER_LOCK } from '../concurrency';
import type { AskUserPayload, AskUserResponse } from '../types';

const cwd = '/repo';

function makeRegistry(askUser?: (payload: AskUserPayload) => Promise<AskUserResponse>) {
  const registry = new ToolRegistry();
  registerDefaultTools(registry);
  return { registry, ctx: { sessionId: 'sess', cwd, askUser } };
}

const validQuestions = [
  { question: 'Auth provider?', options: ['OAuth', 'Session'] },
  { question: 'Styling approach?', options: ['Tailwind', 'Plain CSS'] },
];

describe('ask_user tool', () => {
  it('formats answered results with each question → selected line', async () => {
    const { registry, ctx } = makeRegistry(async () => ({
      kind: 'answered',
      answers: [
        { question: 'Auth provider?', selected: 'OAuth' },
        { question: 'Styling approach?', selected: 'Tailwind' },
      ],
    }));
    const result = await registry.call('ask_user', { questions: validQuestions }, ctx);
    expect(result).toContain('User answered your questions:');
    expect(result).toContain('1. Auth provider? → OAuth');
    expect(result).toContain('2. Styling approach? → Tailwind');
  });

  it('formats skipped results with best-judgment guidance', async () => {
    const { registry, ctx } = makeRegistry(async () => ({ kind: 'skipped' }));
    const result = await registry.call('ask_user', { questions: validQuestions }, ctx);
    expect(result).toContain('skipped the questionnaire');
    expect(result).toContain('best judgment');
  });

  it('falls back gracefully when no askUser channel is wired (headless)', async () => {
    const { registry, ctx } = makeRegistry(undefined);
    const result = await registry.call('ask_user', { questions: validQuestions }, ctx);
    expect(result).toContain('No interactive user available');
    expect(result).toContain('best judgment');
  });

  it('passes the context lead-in through to the UI payload', async () => {
    let received: AskUserPayload | undefined;
    const { registry, ctx } = makeRegistry(async (payload) => {
      received = payload;
      return { kind: 'skipped' };
    });
    await registry.call(
      'ask_user',
      { context: 'Choosing an auth strategy before scaffolding', questions: validQuestions },
      ctx
    );
    expect(received?.context).toBe('Choosing an auth strategy before scaffolding');
    expect(received?.questions).toEqual(validQuestions);
  });

  it('rejects malformed input with descriptive Error strings', async () => {
    const { registry, ctx } = makeRegistry(async () => ({ kind: 'skipped' }));

    // missing questions entirely
    expect(await registry.call('ask_user', {}, ctx)).toMatch(/^Error: /);
    // empty questions array
    expect(await registry.call('ask_user', { questions: [] }, ctx)).toMatch(/^Error: /);
    // missing/blank question text
    expect(
      await registry.call('ask_user', { questions: [{ question: '  ', options: ['a', 'b'] }] }, ctx)
    ).toMatch(/^Error: /);
    // empty options
    expect(
      await registry.call('ask_user', { questions: [{ question: 'q', options: [] }] }, ctx)
    ).toMatch(/^Error: /);
    // fewer than 2 options
    expect(
      await registry.call('ask_user', { questions: [{ question: 'q', options: ['only'] }] }, ctx)
    ).toMatch(/^Error: /);
    // more than 5 questions
    expect(
      await registry.call(
        'ask_user',
        { questions: Array.from({ length: 6 }, () => ({ question: 'q', options: ['a', 'b'] })) },
        ctx
      )
    ).toMatch(/^Error: /);
    // more than 8 options
    expect(
      await registry.call(
        'ask_user',
        { questions: [{ question: 'q', options: Array.from({ length: 9 }, () => 'x') }] },
        ctx
      )
    ).toMatch(/^Error: /);
    // non-string option entries
    expect(
      await registry.call(
        'ask_user',
        { questions: [{ question: 'q', options: ['a', 42 as unknown as string] }] },
        ctx
      )
    ).toMatch(/^Error: /);
  });

  it('returns an error string (not a rejection) when askUser throws', async () => {
    const { registry, ctx } = makeRegistry(async () => {
      throw new Error('UI exploded');
    });
    const result = await registry.call('ask_user', { questions: validQuestions }, ctx);
    expect(result).toContain('Error asking user: UI exploded');
    expect(result).toContain('best judgment');
  });
});

describe('ask_user lock classification', () => {
  it('classifies ask_user to the ASK_USER_LOCK sentinel', () => {
    expect(classifyLockKey('ask_user', { questions: validQuestions }, { sessionId: 's', cwd })).toBe(
      ASK_USER_LOCK
    );
  });

  it('gives two ask_user calls the same key so they serialize', () => {
    const a = classifyLockKey('ask_user', { questions: validQuestions }, { sessionId: 's', cwd });
    const b = classifyLockKey(
      'ask_user',
      { questions: [{ question: 'other', options: ['x', 'y'] }] },
      { sessionId: 's', cwd }
    );
    expect(a).toBe(b);
    expect(a).toBe('__ask_user__');
  });

  it('does not collide with other sentinel locks', () => {
    expect(ASK_USER_LOCK).not.toBe('__bash__');
    expect(ASK_USER_LOCK).not.toBe('__mcp__');
  });
});
