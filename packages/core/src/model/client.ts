import fetch from 'node-fetch';
import https from 'https';
import { AgentConfig, Message, ToolDefinition } from '../types.js';
import { logTrace } from '../logger.js';

export interface ModelResponse {
  content: string;
  tool_calls?: any[];
}

export class ModelClient {
  private agent?: https.Agent;
  private timeoutMs: number;

  constructor(private config: AgentConfig) {
    this.timeoutMs = config.requestTimeoutMs ?? 120_000;
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


  async chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<ModelResponse> {
    const payload: any = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.2,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools.map(t => ({
        type: 'function',
        function: t
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
