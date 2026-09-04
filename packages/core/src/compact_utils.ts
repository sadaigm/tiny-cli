import { AgentConfig, Message } from "./types.js";
import { getEncoding } from "js-tiktoken";

export const DEFAULT_COMPACT_THRESHOLD = 35_000;
export const DEFAULT_COMPACT_RETAIN = 8_000;
export const TOOL_CALLS_PER_COMPACT_CHECK = 10;

/** Token/char stats for a message list (cl100k_base). */
export function measureContext(messages: Message[]): { tokens: number; characters: number } {
  const encoder = getEncoding("cl100k_base");
  let totalTokens = 0;
  let totalChars = 0;

  for (const m of messages) {
    if (m.content) {
      totalChars += m.content.length;
      totalTokens += encoder.encode(m.content).length;
    }

    if (m.tool_calls) {
      const toolCallsStr = JSON.stringify(m.tool_calls);
      totalChars += toolCallsStr.length;
      totalTokens += encoder.encode(toolCallsStr).length;
    }
  }

  return { tokens: totalTokens, characters: totalChars };
}

/** True when compaction should run (tokens over configured threshold). */
export function needsCompaction(messages: Message[], config: AgentConfig): boolean {
  const threshold = config.compactionThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD;
  return measureContext(messages).tokens > threshold;
}

export interface CompactionPlan {
  system: Message[];
  summarize: Message[];
  retain: Message[];
}

/**
 * Split history into { system, summarize, retain }; null when nothing to
 * summarize (everything fits the retention budget).
 */
export function planCompaction(messages: Message[], config: AgentConfig): CompactionPlan | null {
  const system = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const encoder = getEncoding("cl100k_base");
  const targetRetainedTokens = config.compactionRetainTokens ?? DEFAULT_COMPACT_RETAIN;

  let retainedTokens = 0;
  let retainIndex = nonSystem.length;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i];
    let msgTokens = 0;
    if (m.content) msgTokens += encoder.encode(m.content).length;
    if (m.tool_calls) msgTokens += encoder.encode(JSON.stringify(m.tool_calls)).length;

    if (retainedTokens + msgTokens > targetRetainedTokens) {
      break;
    }
    retainedTokens += msgTokens;
    retainIndex = i;
  }

  // Never start the retained window with a tool result: its parent assistant
  // tool_calls message would land in `summarize`, leaving an orphaned tool
  // message that APIs reject ("The messages parameter is illegal"). Push such
  // results into the summarized set instead — their content feeds the summary.
  while (retainIndex < nonSystem.length && nonSystem[retainIndex].role === 'tool') {
    retainIndex++;
  }

  const summarize = nonSystem.slice(0, retainIndex);
  if (summarize.length === 0) {
    return null;
  }

  return { system, summarize, retain: nonSystem.slice(retainIndex) };
}

/** Rebuild history after a summary: system msgs + [PREVIOUS CONTEXT SUMMARY] + retained. */
export function buildCompactedHistory(plan: CompactionPlan, summary: string): Message[] {
  // User role, not system: several OpenAI-compatible APIs (GLM included)
  // reject system messages that are not first in the list ("The messages
  // parameter is illegal"), and this message sits mid-history after compaction.
  const summaryMessage: Message = {
    role: "user",
    content: `[PREVIOUS CONTEXT SUMMARY]\n${summary}`,
  };
  return [...plan.system, summaryMessage, ...plan.retain];
}
