import type { Agent } from '../agent.js';
import type { Message, SubAgentStatus, SubAgentProfile } from '../types.js';

export interface SubAgentInstance {
  id: string;
  name: string;
  status: SubAgentStatus;
  task: string;
  profile: SubAgentProfile;
  agent: Agent;
  sessionId: string;
  parentSessionId: string;
  startedAt: number;
  completedAt?: number;
  currentTool?: string;
  summary?: string;
  error?: string;
  mentorDirections: string[];
  abortController: AbortController;
  /** Background execution promise */
  promise?: Promise<string>;
  /** Optional live UI listeners (KVM switch): forwarded to agent.run while a TUI views this sub-agent. */
  uiCallbacks?: {
    onStep?: (step: import('../types.js').AgentStep) => void;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    /** Fired once when the background run finishes (success or failure). */
    onDone?: (summary: string, error?: string) => void;
  };
  /** Accumulated streamed text for the current run — logged once to tui.log on finish. */
  textBuf?: string;
}

export interface SpawnSubAgentOptions {
  id?: string;
  name?: string;
  profile?: string | SubAgentProfile;
  contextFiles?: string[];
  task: string;
  parentSessionId: string;
  /** Custom working directory if needed */
  cwd?: string;
}

export interface SubAgentSummary {
  id: string;
  name: string;
  status: SubAgentStatus;
  model: string;
  currentTool?: string;
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}

