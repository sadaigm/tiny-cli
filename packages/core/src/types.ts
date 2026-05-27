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

export interface McpServerConfig {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export type PermissionMode = 'notify' | 'auto-edit' | 'auto';
export type LogLevel = 'TRACE' | 'DEBUG' | 'LOG' | 'ERROR';

export interface AgentConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  systemPrompt?: string;
  insecure?: boolean;
  alwaysWrite?: boolean;
  lastSessionId?: string;
  sessionId?: string;
  mcpServers?: McpServerConfig[];
  permissionMode?: PermissionMode;
  logLevel?: LogLevel;
  maxIterations?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any; // JSON Schema
  isModifying?: boolean;
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
  timing?: {
    modelChatMs?: number;
    toolCallMs?: number;
  };
}

export interface AgentResponse {
  content: string;
  steps: AgentStep[];
  plan?: string[];
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  lastUpdatedAt: string;
  title?: string;
  permissionMode?: PermissionMode;
}

export interface Session {
  metadata: SessionMetadata;
  messages: Message[];
}
