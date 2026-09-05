import { ToolCall, ToolDefinition } from "../types.js";

/**
 * Fallback for small local models that emit tool calls as text (often
 * ```json-fenced) instead of native tool_calls. Only whole-message or lone
 * fenced-block JSON is considered — never JSON embedded mid-prose — and the
 * parsed name/arguments must validate against the tool definitions available
 * in the current mode, so legitimate JSON-data replies pass through untouched.
 */
export function extractTextToolCalls(
  content: string,
  toolDefinitions: ToolDefinition[]
): ToolCall[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // Candidates: the whole message, or each fenced block if the message is
  // otherwise just fences + whitespace/prose-free separators.
  const candidates: string[] = [];
  const fenceRegex = /```[a-zA-Z]*\s*([\s\S]*?)```/g;
  const fences = [...trimmed.matchAll(fenceRegex)].map(m => m[1].trim());
  const withoutFences = trimmed.replace(fenceRegex, '').trim();
  if (fences.length > 0 && withoutFences === '') {
    candidates.push(...fences);
  } else {
    candidates.push(trimmed);
  }

  const byName = new Map(toolDefinitions.map(d => [d.name, d]));
  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const def = byName.get(parsed.name);
    if (!def) continue;
    let args = parsed.arguments ?? parsed.parameters ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { continue; }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) continue;
    const props = def.parameters?.properties;
    if (props && !Object.keys(args).every(k => k in props)) continue;
    calls.push({
      id: `text_fallback_${calls.length}_${Date.now()}`,
      type: 'function',
      function: { name: def.name, arguments: JSON.stringify(args) },
    });
  }
  return calls;
}
