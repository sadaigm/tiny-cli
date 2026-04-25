export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ModelOptions {
  model: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface AgentConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  systemPrompt?: string;
  insecure?: boolean;
  alwaysWrite?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any; // JSON Schema
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
}

export type AgentStatus = 'idle' | 'planning' | 'executing' | 'completed' | 'error';

export interface AgentStep {
  thought: string;
  toolCall?: ToolCall;
  toolResult?: string;
}

export interface AgentResponse {
  content: string;
  steps: AgentStep[];
  plan?: string[];
}
