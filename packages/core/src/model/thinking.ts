import { AgentConfig } from '../types.js';

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/**
 * Which wire format a backend expects for controlling reasoning tokens.
 * Detected from the endpoint/model — see {@link thinkingFlavor}.
 */
export type ThinkingFlavor = 'glm' | 'reasoning_effort' | 'chat_template' | 'ollama' | 'gemini';

/**
 * Detects the thinking-parameter flavor for the configured backend:
 *
 * - `glm`            — z.ai / bigmodel endpoints or glm-* models
 *                     (thinking.type enabled/disabled, binary).
 * - `gemini`         — Google AI / Vertex endpoints (thinkingBudget).
 * - `ollama`         — port 11434 or "ollama" in the URL (options.think).
 * - `chat_template`  — "vllm" / "localai" in the URL (chat_template_kwargs).
 * - `reasoning_effort` — everything else (OpenAI o-series, gateways).
 */
export function thinkingFlavor(config: AgentConfig): ThinkingFlavor {
  const ep = (config.endpoint || '').toLowerCase();
  const model = (config.model || '').toLowerCase();
  if (ep.includes('z.ai') || ep.includes('bigmodel') || model.startsWith('glm')) {
    return 'glm';
  }
  if (ep.includes('generativelanguage.googleapis.com') || ep.includes('aiplatform.googleapis.com') || model.startsWith('gemini')) {
    return 'gemini';
  }
  if (ep.includes(':11434') || ep.includes('ollama')) {
    return 'ollama';
  }
  if (ep.includes('vllm') || ep.includes('localai')) {
    return 'chat_template';
  }
  return 'reasoning_effort';
}

/** Thinking levels offered by `/thinking`, per backend flavor. */
export function thinkingLevels(flavor: ThinkingFlavor): ThinkingLevel[] {
  // Binary backends (GLM, vLLM, Ollama) can only toggle reasoning on/off.
  return flavor === 'reasoning_effort' || flavor === 'gemini'
    ? ['off', 'low', 'medium', 'high']
    : ['off', 'high'];
}

/**
 * True when the model cannot disable thinking at all (forced reasoning).
 * Per z.ai docs: GLM-5.3 and GLM-5.3-FLASH use forced thinking.
 */
export function thinkingForced(config: AgentConfig): boolean {
  const model = (config.model || '').toLowerCase();
  return model.startsWith('glm-5.3');
}

/**
 * Applies the configured thinking level to an OpenAI-compatible request
 * payload, in the format the detected backend understands. `off` sends
 * an explicit disable so the server actually stops thinking; only an
 * unset level sends no parameter (server default).
 */
export function applyThinking(payload: any, config: AgentConfig): void {
  const level = config.thinkingLevel;
  if (!level) return; // unset — server default

  switch (thinkingFlavor(config)) {
    case 'glm':
      payload.thinking = { type: level === 'off' ? 'disabled' : 'enabled' };
      break;
    case 'reasoning_effort':
      // GLM accepts 'none' to disable thinking; low/medium/high scale it.
      payload.reasoning_effort = level === 'off' ? 'none' : level;
      break;
    case 'chat_template':
      payload.chat_template_kwargs = { enable_thinking: level !== 'off' };
      break;
    case 'ollama':
      payload.options = { ...(payload.options ?? {}), think: level !== 'off' };
      break;
    case 'gemini':
      // 0 disables; low/medium get fixed token budgets; high = dynamic (-1).
      const budget = level === 'off' ? 0 : level === 'low' ? 512 : level === 'medium' ? 2048 : -1;
      payload.generationConfig = {
        ...(payload.generationConfig ?? {}),
        thinkingConfig: { thinkingBudget: budget },
      };
      break;
  }
}
