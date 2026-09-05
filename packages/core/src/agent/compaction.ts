import { AgentConfig, Message } from "../types.js";
import { ModelClient } from "../model/client.js";
import { logDebug } from "../logger.js";
import {
  DEFAULT_COMPACT_THRESHOLD,
  measureContext,
  planCompaction,
  buildCompactedHistory,
} from "../compact_utils.js";

export interface CompactDeps {
  messages: Message[];
  config: AgentConfig;
  model: ModelClient;
  signal?: AbortSignal;
  force?: boolean;
}

export interface CompactResult {
  history: Message[];
  before: number;
  after: number;
}

/**
 * Threshold-gated memory compaction (moved verbatim from Agent).
 *
 * Summarises the oldest history into a single `[PREVIOUS CONTEXT SUMMARY]`
 * message, keeping the most recent retained tokens verbatim. Returns the
 * rebuilt history + token counts, or null when there was nothing to
 * summarise (under threshold, or everything fits the retention budget).
 * On `force`, errors rethrow; otherwise they are logged and swallowed.
 */
export async function compactMemory(
  deps: CompactDeps
): Promise<CompactResult | null> {
  const { messages, config, model, signal, force = false } = deps;
  const compactionThreshold = config.compactionThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD;
  const stats = measureContext(messages);
  if (!force && stats.tokens <= compactionThreshold) {
    return null;
  }

  if (!force) {
    logDebug(`Context size (${stats.tokens} tokens) exceeds ${compactionThreshold.toLocaleString()}. Compacting memory...`);
  }

  const plan = planCompaction(messages, config);
  if (!plan) {
    return null;
  }

  const summaryPrompt = "Summarize the following conversation history. IDENTIFY THE CURRENT ACTIVE TASK and the state of the implementation. Preserve all key technical decisions, file paths, completed tasks, and context. Do not omit any important technical details, errors, or findings.";

  const summaryMessages: Message[] = [
    ...plan.system,
    ...plan.summarize,
    { role: "user", content: summaryPrompt }
  ];

  try {
    const response = await model.chat(summaryMessages, [], signal);

    const history = buildCompactedHistory(plan, response.content);

    const after = measureContext(history).tokens;
    if (!force) {
      logDebug(`Memory compacted. New context size: ${after} tokens.\n`);
    }
    return { history, before: stats.tokens, after };
  } catch (err: any) {
    if (err.name === 'AbortError' || signal?.aborted) {
      // Aborted, do nothing
    } else if (!force) {
      logDebug(`Memory compaction failed: ${err.message}`);
    }
    if (force) throw err;
    return null;
  }
}
