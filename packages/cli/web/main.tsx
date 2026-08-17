import React from 'react';
import { createRoot } from 'react-dom/client';
import { InkXterm } from 'ink-web/core';
import '@xterm/xterm/css/xterm.css';

import App from '../src/tui/app.js';
import type { AppProps } from '../src/tui/app.js';
import { DEFAULT_THEME } from '../src/tui/theme.js';

/**
 * WEB MODE — view/debug the real <App> + all TUI components in a browser via
 * xterm.js, WITHOUT bundling @tiny-cli/core (which pulls in node-fetch →
 * fetch-blob → Node stream/fs APIs that ink-web's browser shims don't cover
 * and crash Vite's dependency optimizer).
 *
 * Instead we feed <App> a fake Agent/SessionManager that satisfies the same
 * prop surface. Every method returns inert data or a never-resolving promise,
 * so the full UI renders and is interactively debuggable — typing, slash
 * commands, pickers, layout — with no network calls. To run a real agent, use
 * the terminal mode (`pnpm --filter tiny-cli start`).
 */

// ─── Types (minimal mirrors of @tiny-cli/core so we don't import it) ───────

interface FakeConfig {
  endpoint: string;
  model: string;
  permissionMode: 'notify' | 'auto-edit' | 'auto';
  lastSessionId?: string;
}

interface FakeMessage {
  role: string;
  content: string;
}

interface FakeSession {
  metadata: {
    id: string;
    createdAt: string;
    lastUpdatedAt: string;
    title?: string;
    permissionMode?: 'notify' | 'auto-edit' | 'auto';
  };
  messages: FakeMessage[];
}

// ─── Fake Agent / SessionManager ───────────────────────────────────────────
// Implements exactly the member surface <App> + useAgent touch:
//   agent: destroy, getConfig, getContextStats, getHistory,
//          getToolDefinitions, mcpManager.{disconnect,getStatus,getTools,reconnect},
//          run, setHistory, setSessionId, updateConfig
//   sessionManager: listSessions, loadSession, saveSession

const pending = (): Promise<any> => new Promise(() => {});

class FakeAgent {
  private config: FakeConfig;
  private messages: FakeMessage[] = [];
  mcpManager = {
    disconnect: () => pending(),
    getStatus: (_name: string) => 'disconnected',
    getTools: (_name: string) => [],
    reconnect: (_srv: unknown) => pending(),
  };

  constructor(config: FakeConfig) {
    this.config = { ...config };
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
  getConfig(): FakeConfig {
    return this.config;
  }
  getContextStats() {
    return { tokens: 0, characters: 0 };
  }
  getHistory(): FakeMessage[] {
    return this.messages;
  }
  getToolDefinitions(_mode?: string) {
    return [
      { name: 'read_file', description: '(stub) read a file', parameters: {} },
      { name: 'write_file', description: '(stub) write a file', parameters: {} },
    ];
  }
  run(): Promise<any> {
    return pending(); // never resolves — no network in web mode
  }
  setHistory(m: FakeMessage[]) {
    this.messages = [...m];
  }
  setSessionId(_id: string) {}
  updateConfig(updates: Partial<FakeConfig>) {
    this.config = { ...this.config, ...updates };
  }
}

class FakeSessionManager {
  async listSessions() {
    return [{ id: 'web-session' }];
  }
  async loadSession(_id: string): Promise<FakeSession | null> {
    return null;
  }
  async saveSession(_s: FakeSession): Promise<void> {}
}

// ─── Boot ──────────────────────────────────────────────────────────────────

const config: FakeConfig = {
  endpoint: 'http://localhost:11434',
  model: 'llama3.2',
  permissionMode: 'notify',
};

const agent = new FakeAgent(config);
const sessionManager = new FakeSessionManager();
const session: FakeSession = {
  metadata: {
    id: 'web-session',
    createdAt: new Date(0).toISOString(),
    lastUpdatedAt: new Date(0).toISOString(),
    permissionMode: 'notify',
  },
  messages: [],
};
agent.setSessionId(session.metadata.id);

const props = {
  agent,
  sessionManager,
  config,
  sessionId: session.metadata.id,
  session,
  initialMode: 'agent' as const,
  // render.tsx loads the theme from ~/.tiny-cli/theme.json in terminal mode;
  // the browser has no fs — use the built-in default.
  theme: DEFAULT_THEME,
};

const root = createRoot(document.getElementById('root')!);
root.render(
  <InkXterm focus termOptions={{ allowProposedApi: true }}>
    <App {...(props as unknown as AppProps)} />
  </InkXterm>,
);
