import fetch from 'node-fetch';
import https from 'https';
import { AgentConfig, Message, ToolDefinition } from '../types.js';
import { logTrace, logDebug } from '../logger.js';

export interface ModelResponse {
  content: string;
  tool_calls?: any[];
}

export class ModelClient {
  private agent?: https.Agent;
  private timeoutMs: number;

  constructor(private config: AgentConfig) {
    this.timeoutMs = config.requestTimeoutMs ?? 3600_000;
    if (config.insecure && config.endpoint.startsWith('https:')) {
      this.agent = new https.Agent({
        rejectUnauthorized: false
      });
    }
  }

  private combinedSignal(signal?: AbortSignal): AbortSignal {
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeoutMs)];
    if (signal) signals.push(signal);
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }


  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    onText?: (delta: string) => void,
    onReasoning?: (delta: string) => void,
  ): Promise<ModelResponse> {
    // Streaming mode: when the caller wants incremental text, consume the
    // SSE endpoint and reassemble both content and tool-call fragments
    // (OpenAI-compatible streams deliver tool arguments in chunks). Any
    // stream failure falls back to the buffered request below, so
    // `onText` can only add liveness, never break a turn.
    if (onText) {
      try {
        return await this.chatStreamed(messages, tools, signal, onText, onReasoning);
      } catch (err: any) {
        if (err.name === 'AbortError' || signal?.aborted) {
          logDebug(`[trace] chat(): chatStreamed aborted (name=${err?.name}, userSignalAborted=${signal?.aborted}) — rethrowing`);
          throw err;
        }
        logTrace(`chat() — stream failed (${err.message}), falling back to buffered`);
      }
    }

    const payload: any = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.2,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }

    const cMessages = payload.messages.filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'system');
    logTrace(`chat() — sending request to ${this.config.endpoint}/chat/completions, model=${this.config.model}, messages=${cMessages.length}, tools=${payload.tools?.length ?? 0}`);

    const fetchStart = Date.now();
    let response;
    try {
      response = await fetch(`${this.config.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey || 'none'}`
        },
        body: JSON.stringify(payload),
        agent: this.agent,
        signal: this.combinedSignal(signal)
      });
      logTrace(`chat() — response received, status=${response.status}, took=${Date.now() - fetchStart}ms`);
    } catch (err: any) {
      logTrace(`chat() — fetch FAILED after ${Date.now() - fetchStart}ms: ${err.message}`);
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text();
      logTrace(`chat() — API error (${response.status}): ${errorText.slice(0, 200)}`);
      logTrace(`chat() — failed request payload: ${JSON.stringify(payload)}`);
      throw new Error(`Model API error (${response.status}): ${errorText}`);
    }

    logTrace(`chat() — parsing response JSON...`);
    const data: any = await response.json();
    logTrace(`chat() — parsed, content=${(data.choices[0]?.message?.content || '').length} chars, tool_calls=${data.choices[0]?.message?.tool_calls?.length ?? 0}`);
    return {
      content: data.choices[0].message.content || '',
      tool_calls: data.choices[0].message.tool_calls
    };
  }

  /**
   * Streaming variant of {@link chat}: consumes the SSE endpoint, emits
   * content deltas through `onText` as they arrive, and reassembles the
   * full response (including tool calls whose JSON arguments arrive in
   * fragments) to return the same shape as `chat()`.
   */
  private async chatStreamed(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    onReasoning?: (delta: string) => void,
  ): Promise<ModelResponse> {
    const payload: any = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.2,
      stream: true,
    };
    if (tools && tools.length > 0) {
      payload.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }

    const callStart = Date.now();
    logTrace(`chatStreamed() — POST ${this.config.endpoint}/chat/completions, model=${this.config.model}, messages=${messages.length}, tools=${payload.tools?.length ?? 0}, timeoutMs=${this.timeoutMs}`);
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey || 'none'}`,
      },
      body: JSON.stringify(payload),
      agent: this.agent,
      signal: this.combinedSignal(signal),
    }).catch((err: any) => {
      logTrace(`chatStreamed() — fetch FAILED after ${Date.now() - callStart}ms: ${err.name}: ${err.message}`);
      throw err;
    });

    if (!response.ok || !response.body) {
      logTrace(`chatStreamed() — HTTP ${response.status} after ${Date.now() - callStart}ms`);
      logTrace(`chatStreamed() — failed request payload: ${JSON.stringify(payload)}`);
      throw new Error(`Model stream error: ${response.statusText}`);
    }
    logTrace(`chatStreamed() — stream open after ${Date.now() - callStart}ms, consuming deltas…`);

    // node-fetch's abort path emits 'error' on the body stream. If no
    // listener is attached at that instant (e.g. abort fires between awaited
    // chunks), the emit throws synchronously out of abortController.abort()
    // and surfaces as an unhandledRejection. Attach a listener up front so
    // the original error lands in the log instead.
    (response.body as any)?.on?.('error', (err: any) => {
      logTrace(`chatStreamed() — body stream error: ${err?.name}: ${err?.message} (userSignalAborted=${signal?.aborted})`);
    });

    // Tool-call fragments keyed by their stream index: name + argument
    // chunks concatenated until the stream ends.
    const toolCalls: { index: number; id: string; name: string; args: string }[] = [];
    let content = '';

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          let delta: any;
          try {
            delta = JSON.parse(line.slice(6));
          } catch {
            continue; // split JSON — remainder is in the buffer
          }
          const choice = delta.choices?.[0];
          if (!choice) continue;
          const piece = choice.delta?.content;
          if (piece) {
            content += piece;
            onText(piece);
          }
          // Reasoning deltas (Ollama emits `reasoning`, DeepSeek/vLLM emit
          // `reasoning_content`) — forwarded live, not part of the response.
          const thought = choice.delta?.reasoning ?? choice.delta?.reasoning_content;
          if (thought && onReasoning) onReasoning(thought);
          const tc = choice.delta?.tool_calls?.[0];
          if (tc) {
            let slot = toolCalls.find((s) => s.index === (tc.index ?? 0));
            if (!slot) {
              slot = { index: tc.index ?? 0, id: tc.id ?? '', name: '', args: '' };
              toolCalls.push(slot);
            }
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
      }
    } catch (err: any) {
      logDebug(`[trace] chatStreamed stream loop threw: name=${err?.name} message=${err?.message} userSignalAborted=${signal?.aborted}`);
      // User abort mid-stream is a normal end of turn, not an error —
      // return what streamed so far. A bare AbortError here would otherwise
      // surface as an unhandledRejection from the aborted body stream.
      if (err.name === 'AbortError' || signal?.aborted) {
        logTrace(`chatStreamed() — aborted mid-stream after ${content.length} chars; returning partial response`);
        return {
          content,
          tool_calls: toolCalls.length
            ? toolCalls.map((s) => ({
                id: s.id,
                type: 'function' as const,
                function: { name: s.name, arguments: s.args },
              }))
            : undefined,
        };
      }
      throw err;
    }

    logTrace(`chatStreamed() — done in ${Date.now() - callStart}ms, content=${content.length} chars, tool_calls=${toolCalls.length}`);

    return {
      content,
      tool_calls: toolCalls.length
        ? toolCalls.map((s) => ({
            id: s.id,
            type: 'function',
            function: { name: s.name, arguments: s.args },
          }))
        : undefined,
    };
  }

  async *stream(messages: Message[], signal?: AbortSignal): AsyncGenerator<string> {
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey || 'none'}`
      },
      agent: this.agent,
      signal: this.combinedSignal(signal),
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: this.config.temperature ?? 0.2,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Model stream error: ${response.statusText}`);
    }

    const body = response.body;
    if (!body) return;

    for await (const chunk of body) {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            const content = data.choices[0]?.delta?.content;
            if (content) yield content;
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    }
  }
}
