import {
  CompactionPlan,
  DEFAULT_COMPACT_THRESHOLD,
  measureContext,
  needsCompaction,
  planCompaction,
  buildCompactedHistory,
} from '../compact_utils.js';
import { Message } from '../types.js';

function bigMessage(prefix: string, tokens: number): Message {
  // ~4 chars per token for cl100k on English-ish text
  return { role: 'user', content: `${prefix} ${'x '.repeat(tokens * 2)}` };
}

describe('compact_utils', () => {
  describe('measureContext', () => {
    it('counts content and tool_calls tokens/chars', () => {
      const msgs: Message[] = [
        { role: 'system', content: 'hello world' },
        { role: 'assistant', content: 'hi', tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{}' } }] as any },
      ];
      const stats = measureContext(msgs);
      expect(stats.tokens).toBeGreaterThan(0);
      expect(stats.characters).toBe('hello world'.length + 'hi'.length + JSON.stringify(msgs[1].tool_calls).length);
    });
  });

  describe('needsCompaction', () => {
    it('is false at/below the threshold', () => {
      const tokens = 100;
      // Build messages whose measured size is known
      const msgs = [bigMessage('a', tokens)];
      const measured = measureContext(msgs).tokens;
      expect(needsCompaction(msgs, { compactionThresholdTokens: measured } as any)).toBe(false);
      expect(needsCompaction(msgs, { compactionThresholdTokens: measured - 1 } as any)).toBe(true);
    });

    it('uses DEFAULT_COMPACT_THRESHOLD when unset', () => {
      const msgs = [bigMessage('a', DEFAULT_COMPACT_THRESHOLD + 1000)];
      expect(needsCompaction(msgs, {} as any)).toBe(true);
    });
  });

  describe('planCompaction', () => {
    it('returns null when nothing to summarize (all fits retention)', () => {
      const msgs = [bigMessage('a', 100)];
      expect(planCompaction(msgs, { compactionRetainTokens: 8000 } as any)).toBeNull();
    });

    it('keeps most-recent messages within the retain budget', () => {
      const msgs: Message[] = [
        { role: 'system', content: 'sys' },
        bigMessage('old1', 2000),
        bigMessage('old2', 2000),
        { role: 'user', content: 'recent question' },
      ];
      const plan = planCompaction(msgs, { compactionRetainTokens: 50 } as any)!;
      expect(plan).not.toBeNull();
      expect(plan.system).toEqual([{ role: 'system', content: 'sys' }]);
      // The two big old messages get summarized; the small recent one retained
      expect(plan.summarize.length).toBe(2);
      expect(plan.retain).toEqual([{ role: 'user', content: 'recent question' }]);
    });
  });

  describe('buildCompactedHistory', () => {
    it('places summary between system messages and retained tail', () => {
      const plan: CompactionPlan = {
        system: [{ role: 'system', content: 'sys' }],
        summarize: [{ role: 'user', content: 'old' }],
        retain: [{ role: 'user', content: 'new' }],
      };
      const history = buildCompactedHistory(plan, 'the summary');
      expect(history).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'system', content: '[PREVIOUS CONTEXT SUMMARY]\nthe summary' },
        { role: 'user', content: 'new' },
      ]);
    });
  });
});
