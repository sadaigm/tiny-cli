import { ToolCall, ToolDefinition } from "../types.js";

/**
 * Fallback for small local models that emit tool calls as text instead of
 * native tool_calls. Two text shapes are recognised:
 *
 * 1. JSON (often ```json-fenced): only whole-message or lone fenced-block
 *    JSON is considered — never JSON embedded mid-prose.
 * 2. Pseudo-XML drift observed from quantized Qwen models:
 *        <tool_call>
 *        <function=write>
 *        <parameter=path>
 *        ai_os_design.md
 *        </parameter>
 *        <parameter=content>…file body…</parameter>
 *        </function>
 *        </tool_call>
 *    The block is explicit and self-delimiting, so surrounding prose is
 *    allowed (the model often narrates before the call). Only COMPLETE
 *    blocks (closing </function> or </tool_call> seen) are promoted — a
 *    block cut off by a token limit would execute a half-written file.
 *
 * In both shapes the parsed name/arguments must validate against the tool
 * definitions available in the current mode, so legitimate replies that
 * merely mention tool syntax pass through untouched.
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

  // Pseudo-XML drift (see doc comment). Values arrive as raw strings — one
  // leading/trailing newline is template formatting, everything between is
  // the exact value (multi-line file content must survive byte-for-byte).
  const callRe = /<tool_call>\s*<function=([A-Za-z0-9_.-]+)>([\s\S]*?)(?:<\/function>|<\/tool_call>)/g;
  const paramRe = /<parameter=([A-Za-z0-9_.-]+)>\r?\n?([\s\S]*?)<\/parameter>/g;
  for (const call of content.matchAll(callRe)) {
    const def = byName.get(call[1]);
    if (!def) continue;
    const args: Record<string, string> = {};
    for (const p of call[2].matchAll(paramRe)) {
      args[p[1]] = p[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    }
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
