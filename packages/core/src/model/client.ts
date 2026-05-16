import fetch from 'node-fetch';
import https from 'https';
import { AgentConfig, Message, ToolDefinition } from '../types.js';

export interface ModelResponse {
  content: string;
  tool_calls?: any[];
}

export class ModelClient {
  private agent?: https.Agent;

  constructor(private config: AgentConfig) {
    if (config.insecure) {
      this.agent = new https.Agent({
        rejectUnauthorized: false
      });
    }
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
      // Do NOT set tool_choice: 'auto' — on small models like Llama 3.2,
      // this overrides system prompt instructions and forces a tool call every time.
      // Let the model decide freely based on the system prompt.
    }
    // add a debug for payload in single line json
    const cMessages = payload.messages.filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'system');

    console.log('Payload:', JSON.stringify({ messages: cMessages }));

    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey || 'none'}`
      },
      body: JSON.stringify(payload),
      agent: this.agent,
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Model API error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    // console.log('Response:', JSON.stringify(data, null, 2));
    return {
      content: data.choices[0].message.content || '',
      tool_calls: data.choices[0].message.tool_calls
    };
  }

  async *stream(messages: Message[]): AsyncGenerator<string> {
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey || 'none'}`
      },
      agent: this.agent,
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
