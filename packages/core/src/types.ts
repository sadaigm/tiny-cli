export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

import type { LoadSkillsOptions } from "@tiny-cli/resources";

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
  requestTimeoutMs?: number;
  maxIterations?: number;
  /** Token count at which the agent compacts older conversation history into a summary. Defaults to 35000. */
  compactionThresholdTokens?: number;
  /** Number of recent tokens kept raw (not summarized) during memory compaction. Defaults to 8000. */
  compactionRetainTokens?: number;
  /** Options for agent-skill discovery; when set, available skills are injected into the system prompt. */
  skillsOptions?: LoadSkillsOptions;
  /** Whether /skill:<name> commands are enabled in the TUI. Defaults to true. */
  enableSkillCommands?: boolean;
  /** Names of skills the user activated (e.g. via /skills); their full body is injected into the system prompt on every run. */
  activeSkills?: string[];
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
  /**
   * True when the final assistant text was already delivered
   * incrementally through the `run()` `onText` callback — lets the UI
   * skip re-appending the full blob after the turn ends.
   */
  streamedFinal?: boolean;
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

/** One multiple-choice question shown to the user. */
export interface AskUserQuestion {
  question: string;
  options: string[];
}

/** Full questionnaire payload the ask_user tool sends to the UI. */
export interface AskUserPayload {
  context?: string;
  questions: AskUserQuestion[];
}

/** One collected answer. */
export interface AskUserAnswer {
  question: string;
  selected: string;
}

/** Result of showing the questionnaire to the user. */
export type AskUserResponse =
  | { kind: 'answered'; answers: AskUserAnswer[] }
  | { kind: 'skipped' };
