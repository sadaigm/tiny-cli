import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { SessionManager } from '@tiny-cli/core';
import type { Agent, Session, AgentConfig } from '@tiny-cli/core';

import type { TuiState, TuiMode, LogEntry, ContextStats, PendingSelector, SelectorKind } from './state.js';
import AutocompletePopover from './components/AutocompletePopover.js';
import Header from './components/Header.js';
import StatusBar from './components/StatusBar.js';
import MessageLog, { type MessageLogHandle } from './components/MessageLog.js';
import StdinMouseBridge from './components/StdinMouseBridge.js';
import Spinner from './components/Spinner.js';
import InputBox from './components/InputBox.js';
import ApprovalModal from './components/ApprovalModal.js';
import RecoveryModal from './components/RecoveryModal.js';

import { useConsoleCapture } from './hooks/useConsoleCapture.js';
import { useAgent, type UseAgentStatePatch, type NewLogEntry } from './hooks/useAgent.js';

import { hydrateMessage, buildFileIndex } from '../file-mention.js';
import { fetchModels } from '../commands/handlers.js';
import { SLASH_COMMANDS } from './utils/commands.js';
import { findInLog } from './utils/logSearch.js';
import type { Theme } from './theme.js';
import { bindingFor, matchesBinding } from './keybindings.js';

// ─── Initial state ─────────────────────────────────────────────────

/** Key reference printed by `/help` (kept beside the command table). */
const HELP_KEY_LINES: string[] = [
  'Enter        submit · Shift+Enter newline · ↑/↓ recall input history',
  'Ctrl+R       search input history (Enter accepts · Esc cancels)',
  'Ctrl+P       browse mode (↑/↓ scroll · Tab expand · y copy · Esc back)',
  'Ctrl+S       switch session (opens the /session picker)',
  'Esc          abort the running turn',
  'Ctrl+C ×2    exit (Ctrl+D exits immediately)',
  '/  @         command / file-mention pickers',
  '/mouse on    enable mouse-wheel scrolling',
];

/** Compact relative time like "2d ago" / "3h ago" / "just now". */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function createInitialState(
  config: AgentConfig,
  sessionId: string,
  mode: TuiMode,
  permissionMode: 'notify' | 'auto-edit' | 'auto',
): TuiState {
  return {
    agentState: 'idle',
    mode,
    log: [],
    pendingApproval: null,
    messageQueue: [],
    spinnerText: '',
    showAutocomplete: false,
    autocompleteItems: [],
    autocompleteSelected: 0,
    contextStats: { tokens: 0, characters: 0 },
    pendingRecovery: null,
    planExecuting: false,
    pendingSelector: null,
    // Mouse scroll is opt-in: Ink v5 reads stdin itself, so SGR mouse
    // reports leak into the text input. Enable with `/mouse` only.
    mouseEnabled: false,
    _config: config,
    _sessionId: sessionId,
    _permissionMode: permissionMode,
  };
}

// Extend TuiState with internal-only fields needed by App
// (We store config/sessionId/permissionMode in state so they can be
// updated via reducer and reflected in re-renders.)
declare module './state.js' {
  interface TuiState {
    _config?: AgentConfig;
    _sessionId?: string;
    _permissionMode?: 'notify' | 'auto-edit' | 'auto';
  }
}

// ─── Reducer ───────────────────────────────────────────────────────

type Action =
  | { type: 'PATCH'; patch: Partial<TuiState> }
  | { type: 'ADD_LOG'; entry: NewLogEntry }
  | { type: 'APPEND_LOG_TEXT'; id: string; delta: string }
  | { type: 'SET_MODE'; mode: TuiMode }
  | { type: 'CLEAR_LOG' }
  | { type: 'SET_PERMISSION_MODE'; mode: 'notify' | 'auto-edit' | 'auto' }
  | { type: 'SET_CONFIG'; config: AgentConfig }
  | { type: 'SET_SESSION_ID'; sessionId: string }
  | { type: 'SET_LOG_LIVE'; id: string; live: boolean }
  | { type: 'OPEN_SELECTOR'; selector: PendingSelector }
  | { type: 'CLOSE_SELECTOR' }
  | { type: 'MOVE_SELECTOR'; direction: 'up' | 'down' };

let logIdCounter = 0;

function reducer(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case 'PATCH':
      return { ...state, ...action.patch };

    case 'ADD_LOG': {
      const entry: LogEntry = {
        id: action.entry._id ?? `log-${++logIdCounter}`,
        timestamp: Date.now(),
        type: action.entry.type,
        content: action.entry.content,
        toolName: action.entry.toolName,
        toolArgs: action.entry.toolArgs,
        toolResult: action.entry.toolResult,
        timing: action.entry.timing,
        queued: action.entry.queued,
        live: action.entry.live,
      };
      return { ...state, log: [...state.log, entry] };
    }

    case 'APPEND_LOG_TEXT': {
      // Streaming: append a text delta to one existing entry (the live
      // assistant message). Mutating a copy keeps the array identity
      // changing so memoized panes re-render only for this entry.
      const idx = state.log.findIndex((e) => e.id === action.id);
      if (idx === -1) return state;
      const log = [...state.log];
      log[idx] = { ...log[idx], content: log[idx].content + action.delta };
      return { ...state, log };
    }

    case 'SET_LOG_LIVE': {
      const idx = state.log.findIndex((e) => e.id === action.id);
      if (idx === -1 || state.log[idx].live === action.live) return state;
      const log = [...state.log];
      log[idx] = { ...log[idx], live: action.live };
      return { ...state, log };
    }

    case 'SET_MODE':
      return { ...state, mode: action.mode };

    case 'CLEAR_LOG':
      return { ...state, log: [] };

    case 'SET_PERMISSION_MODE':
      return { ...state, _permissionMode: action.mode };

    case 'SET_CONFIG':
      return { ...state, _config: action.config };

    case 'SET_SESSION_ID':
      return { ...state, _sessionId: action.sessionId };

    case 'OPEN_SELECTOR':
      return { ...state, pendingSelector: action.selector };

    case 'CLOSE_SELECTOR':
      return { ...state, pendingSelector: null };

    case 'MOVE_SELECTOR': {
      if (!state.pendingSelector) return state;
      const { selectedIndex, items } = state.pendingSelector;
      const max = items.length - 1;
      const next =
        action.direction === 'up'
          ? selectedIndex <= 0
            ? max
            : selectedIndex - 1
          : selectedIndex >= max
            ? 0
            : selectedIndex + 1;
      return {
        ...state,
        pendingSelector: { ...state.pendingSelector, selectedIndex: next },
      };
    }

    default:
      return state;
  }
}

// ─── App Props ─────────────────────────────────────────────────────

export interface AppProps {
  agent: Agent;
  sessionManager: SessionManager;
  config: AgentConfig;
  sessionId: string;
  session: Session;
  initialMode: TuiMode;
  /** Colour theme (loaded once from ~/.tiny-cli/theme.json). */
  theme: Theme;
}

// ─── Component ─────────────────────────────────────────────────────

export default function App({
  agent,
  sessionManager,
  config,
  sessionId,
  session,
  initialMode,
  theme,
}: AppProps): React.ReactElement {
  const { exit } = useApp();

  const [state, dispatch] = useReducer(
    reducer,
    createInitialState(config, sessionId, initialMode, session.metadata.permissionMode || config.permissionMode || 'notify'),
  );

  // ── Refs for values needed inside callbacks ──
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Ref to the conversation pane (for mouse-wheel scrolling) ──
  const paneRef = useRef<MessageLogHandle>(null);

  // ── Browse mode: when on, the InputBox is hidden so the conversation pane
  //    owns arrows/Tab without conflicting with text input. ──
  const [browseMode, setBrowseMode] = React.useState(false);

  // TEMP debug: log raw stdin bytes BEFORE Ink parses them, to capture the
  // exact escape sequences the terminal sends for Home/End/Shift+Enter.
  // Enable with TINY_CLI_KEY_LOG=<path>. This is a parallel stdin reader —
  // it does not consume bytes (Ink still gets them).
  // ── Workspace file index for the @file-mention picker (built once). ──
  const [fileIndex, setFileIndex] = React.useState<string[]>([]);
  // True while the @file-mention picker is open (so the conversation pane
  // yields ↑/↓ to it).
  const [mentionActive, setMentionActive] = React.useState(false);
  // True while Ctrl+R reverse-i-search owns the input line — mirrored in a
  // ref for the global Esc handler (abort turn) to read synchronously.
  const [searchActive, setSearchActive] = React.useState(false);
  const searchActiveRef = React.useRef(false);
  searchActiveRef.current = searchActive;
  // Mirrored in a ref for the same reason: the global Esc handler reads it
  // synchronously to know when browse mode owns Esc.
  const browseModeRef = React.useRef(false);
  browseModeRef.current = browseMode;
  useEffect(() => {
    let cancelled = false;
    buildFileIndex(process.cwd())
      .then((idx) => {
        if (!cancelled) setFileIndex(idx);
      })
      .catch(() => {
        // index unavailable — picker stays empty, typing still works
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Imperative state patcher for useAgent ──
  const setStateForAgent = useCallback((patch: UseAgentStatePatch) => {
    dispatch({ type: 'PATCH', patch: patch as Partial<TuiState> });
  }, []);

  // ── Log helpers ──
  const addLog = useCallback((entry: NewLogEntry) => {
    dispatch({ type: 'ADD_LOG', entry });
  }, []);

  // Streaming support: append a delta to one entry by id, and reserve the
  // id a future ADD_LOG will use (so the live assistant entry exists
  // before its first delta arrives). Both feed the same reducer.
  const appendLogText = useCallback((id: string, delta: string) => {
    dispatch({ type: 'APPEND_LOG_TEXT', id, delta });
  }, []);

  const reserveLogId = useCallback((): string => `log-${++logIdCounter}`, []);

  const setLogLive = useCallback((id: string, live: boolean) => {
    dispatch({ type: 'SET_LOG_LIVE', id, live });
  }, []);

  const addSystemLog = useCallback((content: string) => {
    dispatch({ type: 'ADD_LOG', entry: { type: 'system', content } });
  }, []);

  const addErrorLog = useCallback((content: string) => {
    dispatch({ type: 'ADD_LOG', entry: { type: 'error', content } });
  }, []);

  // ── Console capture ──
  useConsoleCapture((entry) => {
    dispatch({ type: 'ADD_LOG', entry });
  });

  // ── Agent hook ──
  const agentApi = useAgent({
    agent,
    sessionManager,
    sessionId: state._sessionId ?? sessionId,
    setState: setStateForAgent,
    addLog,
    appendLogText,
    reserveLogId,
    setLogLive,
    getMode: () => stateRef.current.mode,
  });

  // ── Slash command handling ──
  const handleSlashCommand = useCallback(
    async (input: string): Promise<boolean> => {
      // Returns true if the command was handled
      const parts = input.slice(1).split(' ');
      const cmd = parts[0]?.toLowerCase();

      // /skill:<name> [args] — send the skill's full SKILL.md content to the agent
      if (cmd?.startsWith('skill:')) {
        const cfg = agent.getConfig();
        if (cfg.enableSkillCommands === false) {
          addErrorLog('Skill commands are disabled (enableSkillCommands: false).');
          return true;
        }
        const skillName = cmd.slice('skill:'.length);
        const argsText = parts.slice(1).join(' ');
        try {
          const { loadSkills } = await import('@tiny-cli/resources');
          const result = await loadSkills(
            cfg.skillsOptions ?? { settingsSkills: [], cliSkills: [], noSkills: false, trusted: false }
          );
          const skill = result.skills.find((s) => s.name === skillName);
          if (!skill) {
            addErrorLog(`Unknown skill "${skillName}". Available: ${result.skills.map((s) => s.name).join(', ') || '(none)'}`);
            return true;
          }
          const fs = await import('node:fs/promises');
          const content = await fs.readFile(skill.path, 'utf-8');
          agentApi.submitMessage(argsText ? `${content}\n\nUser: ${argsText}` : content);
        } catch (err: any) {
          addErrorLog(`Skill command failed: ${err.message}`);
        }
        return true;
      }

      // /skills — open a selector to activate/deactivate skills; active
      // skill bodies are injected into the system prompt on every run.
      if (cmd === 'skills') {
        const cfg = agent.getConfig();
        try {
          const { loadSkills } = await import('@tiny-cli/resources');
          const result = await loadSkills(
            cfg.skillsOptions ?? { settingsSkills: [], cliSkills: [], noSkills: false, trusted: false }
          );
          if (result.skills.length === 0) {
            addSystemLog('No skills loaded. Add skills under ~/.tiny-cli/agent/skills/ or .tiny-cli/skills/.');
          } else {
            const active = new Set(cfg.activeSkills ?? []);
            dispatch({
              type: 'OPEN_SELECTOR',
              selector: {
                kind: 'skill',
                title: `Select Skill to activate/deactivate (active: ${active.size})`,
                items: result.skills.map((s) => ({
                  label: `${active.has(s.name) ? '●' : '○'} ${s.name === 'create-skill' ? 'skills-generator' : s.name}`,
                  value: s.name,
                  description:
                    s.name === 'create-skill'
                      ? 'built-in: scaffolds new skills (/create-skill)'
                      : s.description.split('\n')[0].slice(0, 80),
                })),
                selectedIndex: 0,
              },
            });
          }
          for (const w of result.warnings) addSystemLog(`Skill warning: ${w.message}`);
        } catch (err: any) {
          addErrorLog(`Failed to list skills: ${err.message}`);
        }
        return true;
      }

      switch (cmd) {
        case 'exit':
        case 'quit': {
          try {
            const c = stateRef.current._config;
            if (c) {
              c.lastSessionId = stateRef.current._sessionId;
              const { saveConfig } = await import('../config.js');
              await saveConfig(c);
            }
            await agent.destroy();
          } catch {
            // ignore
          }
          exit();
          return true;
        }

        case 'agent':
          dispatch({ type: 'SET_MODE', mode: 'agent' });
          addSystemLog('Switched to agent mode.');
          return true;

        case 'chat':
          dispatch({ type: 'SET_MODE', mode: 'chat' });
          addSystemLog('Switched to chat mode.');
          return true;

        case 'plan':
          dispatch({ type: 'SET_MODE', mode: 'plan' });
          addSystemLog('Switched to plan mode.');
          return true;

        case 'mouse': {
          // Toggle mouse-wheel scrolling of the conversation pane.
          const arg = parts[1]?.toLowerCase();
          const next = arg === 'on' ? true : arg === 'off' ? false : !stateRef.current.mouseEnabled;
          dispatch({ type: 'PATCH', patch: { mouseEnabled: next } });
          addSystemLog(`Mouse scroll ${next ? 'enabled' : 'disabled'}.`);
          return true;
        }

        case 'clear':
          agent.setHistory([]);
          session.messages = [];
          try {
            await sessionManager.saveSession(session);
          } catch {
            // ignore
          }
          dispatch({ type: 'CLEAR_LOG' });
          addSystemLog('History cleared.');
          return true;

        case 'tools': {
          const tools = agent.getToolDefinitions(stateRef.current.mode);
          addSystemLog(`Available tools (${stateRef.current.mode} mode):`);
          for (const tool of tools) {
            dispatch({
              type: 'ADD_LOG',
              entry: {
                type: 'info',
                content: `  ${tool.name}: ${tool.description.split('\n')[0]}`,
              },
            });
          }
          return true;
        }

        case 'model': {
          // Use the pure fetchModels() from handlers.ts
          const c = agent.getConfig();
          const requestedModel = parts[1];

          // Direct switch: /model <name>
          if (requestedModel) {
            try {
              const available = await fetchModels(c);
              if (!available.includes(requestedModel)) {
                addErrorLog(`Model "${requestedModel}" not found. Available: ${available.join(', ')}`);
                return true;
              }
              agent.updateConfig({ model: requestedModel });
              const updated = agent.getConfig();
              dispatch({ type: 'SET_CONFIG', config: updated });
              addSystemLog(`Model updated to: ${requestedModel}`);
            } catch (err: any) {
              addErrorLog(`Error: ${err.message}`);
            }
            return true;
          }

          // Open model picker overlay
          addSystemLog('Fetching available models...');
          try {
            const models = await fetchModels(c);
            if (models.length === 0) {
              addSystemLog('No models found at this endpoint.');
              return true;
            }
            const currentIndex = models.indexOf(c.model);
            dispatch({
              type: 'OPEN_SELECTOR',
              selector: {
                kind: 'model',
                title: `Select Model (current: ${c.model})`,
                items: models,
                selectedIndex: currentIndex >= 0 ? currentIndex : 0,
              },
            });
          } catch (err: any) {
            addErrorLog(`Error fetching models: ${err.message}`);
          }
          return true;
        }

        case 'mode': {
          const requested = parts[1]?.toLowerCase();
          if (requested && ['notify', 'auto-edit', 'auto'].includes(requested)) {
            const newMode = requested as 'notify' | 'auto-edit' | 'auto';
            const c = agent.getConfig();
            c.permissionMode = newMode;
            agent.updateConfig(c);
            session.metadata.permissionMode = newMode;
            try {
              await sessionManager.saveSession(session);
            } catch {
              // ignore
            }
            dispatch({ type: 'SET_PERMISSION_MODE', mode: newMode });
            addSystemLog(`Permission mode set to: ${newMode}`);
          } else {
            // Open mode picker overlay
            const modes = ['notify', 'auto-edit', 'auto'];
            const current = stateRef.current._permissionMode ?? 'notify';
            dispatch({
              type: 'OPEN_SELECTOR',
              selector: {
                kind: 'mode',
                title: `Select Permission Mode (current: ${current})`,
                items: modes,
                selectedIndex: Math.max(0, modes.indexOf(current)),
              },
            });
          }
          return true;
        }

        case 'session': {
          const subCmd = parts[1]?.toLowerCase();
          if (subCmd === 'load') {
            const id = parts[2];
            if (!id) {
              addSystemLog('Usage: /session load <id>');
              return true;
            }
            const newSession = await sessionManager.loadSession(id);
            if (newSession) {
              agent.setSessionId(id);
              agent.setHistory(newSession.messages);
              dispatch({ type: 'SET_SESSION_ID', sessionId: id });
              dispatch({ type: 'CLEAR_LOG' });
              addSystemLog(`Loaded session: ${id}`);
              for (const m of newSession.messages) {
                if (m.role === 'user' || m.role === 'assistant') {
                  addLog({ type: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
                }
              }
            } else {
              addErrorLog(`Session not found: ${id}`);
            }
            return true;
          } else if (subCmd === 'new') {
            const id = parts[2] || crypto.randomUUID();
            const newSession = SessionManager.createSession(id);
            agent.setSessionId(id);
            agent.setHistory([]);
            await sessionManager.saveSession(newSession);
            dispatch({ type: 'SET_SESSION_ID', sessionId: id });
            dispatch({ type: 'CLEAR_LOG' });
            addSystemLog(`Started new session: ${id}`);
            return true;
          }

          // Default: open session picker overlay
          const sessions = await sessionManager.listSessions();
          if (sessions.length === 0) {
            addSystemLog('No saved sessions found. Use /session new to create one.');
            return true;
          }
          const sessionItems = await Promise.all(
            sessions.map(async (s) => {
              // First user message makes the session recognisable in the list.
              const full = await sessionManager.loadSession(s.id);
              const firstUser = full?.messages.find((m) => m.role === 'user' && m.content);
              const preview =
                (firstUser?.content as string | undefined)?.replace(/\s+/g, ' ').trim().slice(0, 60) ||
                '(empty)';
              return {
                label: preview,
                value: s.id,
                description: `${relativeTime(s.lastUpdatedAt)} · ${s.id.slice(0, 8)}`,
              };
            }),
          );
          dispatch({
            type: 'OPEN_SELECTOR',
            selector: {
              kind: 'session',
              title: 'Select Session to Load',
              items: sessionItems,
              selectedIndex: 0,
            },
          });
          return true;
        }

        case 'mcp': {
          const servers = agent.getConfig().mcpServers || [];
          if (servers.length === 0) {
            addSystemLog('No MCP servers configured.');
            return true;
          }
          const subCmd = parts[1]?.toLowerCase();
          if (!subCmd || subCmd === 'list') {
            // Show status inline, then open a picker to reconnect a server.
            addSystemLog('MCP servers:');
            for (const srv of servers) {
              const status = agent.mcpManager.getStatus(srv.name);
              const tools = agent.mcpManager.getTools(srv.name);
              dispatch({
                type: 'ADD_LOG',
                entry: {
                  type: 'info',
                  content: `  ${srv.name} [${srv.type}] (${status}) — ${tools.length} tools`,
                },
              });
            }
            addSystemLog('Select a server to reconnect (or use /mcp reconnect|disconnect|tools <name>).');
            dispatch({
              type: 'OPEN_SELECTOR',
              selector: {
                kind: 'mcp',
                title: 'Select MCP Server to Reconnect',
                items: servers.map((s) => s.name),
                selectedIndex: 0,
              },
            });
          } else if (subCmd === 'reconnect') {
            const serverName = parts[2];
            const srv = servers.find((s) => s.name === serverName);
            if (srv) {
              addSystemLog(`Reconnecting to ${serverName}...`);
              await agent.mcpManager.reconnect(srv);
              addSystemLog(`Reconnected to ${serverName}.`);
            }
          } else if (subCmd === 'disconnect') {
            const serverName = parts[2];
            await agent.mcpManager.disconnect(serverName);
            addSystemLog(`Disconnected ${serverName}.`);
          } else if (subCmd === 'tools') {
            const serverName = parts[2];
            const tools = agent.mcpManager.getTools(serverName);
            addSystemLog(`Tools for ${serverName}:`);
            for (const t of tools) {
              dispatch({
                type: 'ADD_LOG',
                entry: { type: 'info', content: `  ${t.definition.name}` },
              });
            }
          }
          return true;
        }

        case 'continue': {
          // Trigger structured plan execution
          addSystemLog('Starting plan execution...');
          agentApi.executePlan();
          return true;
        }

        case 'help':
        case '?': {
          addSystemLog('Commands:');
          for (const cmd of SLASH_COMMANDS) {
            dispatch({
              type: 'ADD_LOG',
              entry: { type: 'info', content: `  /${cmd.name.padEnd(9)} ${cmd.description}` },
            });
          }
          addSystemLog('Keys:');
          for (const line of HELP_KEY_LINES) {
            dispatch({ type: 'ADD_LOG', entry: { type: 'info', content: `  ${line}` } });
          }
          return true;
        }

        case 'find': {
          const query = input.slice(cmd.length + 2).trim();
          if (!query) {
            addSystemLog('Usage: /find <text> — jump to messages containing the text.');
            return true;
          }
          const hits = findInLog(stateRef.current.log, query);
          if (hits.length === 0) {
            addSystemLog(`No matches for "${query}".`);
            return true;
          }
          // List hits newest-first, then jump to the most recent one and
          // hand the pane to browse mode so ↑/↓ can walk the other hits
          // (and everything around them).
          addSystemLog(`Found ${hits.length} match${hits.length !== 1 ? 'es' : ''} for "${query}":`);
          hits.slice(0, 20).forEach((hit) => {
            dispatch({
              type: 'ADD_LOG',
              entry: {
                type: 'info',
                content: `  #${hit.matchNumber} [${hit.type}] ${hit.preview}`,
              },
            });
          });
          if (hits.length > 20) {
            addSystemLog(`  …and ${hits.length - 20} older match${hits.length - 20 !== 1 ? 'es' : ''}.`);
          }
          setBrowseMode(true);
          paneRef.current?.focusEntry(hits[0].id);
          return true;
        }

        case 'compact': {
          const before = agent.getContextStats().tokens;
          addSystemLog(`Compacting memory (${before.toLocaleString()} tokens)…`);
          try {
            const after = await agent.compactNow();
            if (after === null) {
              addSystemLog('Nothing to compact — recent history already fits the retention budget.');
            } else {
              addSystemLog(`Memory compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens.`);
              await sessionManager.saveSession(session);
            }
          } catch (err: any) {
            addErrorLog(`Compaction failed: ${err.message}`);
          }
          return true;
        }

        case 'queue': {
          const queued = stateRef.current.messageQueue;
          if (parts[1]?.toLowerCase() === 'clear') {
            agentApi.clearQueue();
            return true;
          }
          if (queued.length === 0) {
            addSystemLog('Queue is empty. Messages submitted while the agent is working wait here.');
            return true;
          }
          addSystemLog(`${queued.length} queued message${queued.length !== 1 ? 's' : ''}:`);
          queued.forEach((msg, i) => {
            dispatch({
              type: 'ADD_LOG',
              entry: { type: 'info', content: `  ${i + 1}. ${msg}` },
            });
          });
          addSystemLog('Use /queue clear to drop them.');
          return true;
        }

        case 'create-skill': {
          const args = parts.slice(1);
          const useGlobal = args.includes('--global');
          const useProject = args.includes('--project');
          let skillName = '';
          const rest: string[] = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--name' && args[i + 1]) {
              skillName = args[++i];
            } else if (!args[i].startsWith('--')) {
              rest.push(args[i]);
            }
          }
          const description = rest.join(' ').trim();
          if (!description) {
            addErrorLog('Usage: /create-skill [--global|--project] [--name <n>] <description>');
            return true;
          }
          if (!skillName) {
            skillName = description
              .toLowerCase()
              .split(/\s+/)
              .slice(0, 4)
              .join('-')
              .replace(/[^a-z0-9-]/g, '')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 64);
          }
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName) || skillName.length > 64) {
            addErrorLog(`Invalid skill name "${skillName}". Use lowercase a-z, 0-9 and single hyphens (1-64 chars).`);
            return true;
          }
          const os = await import('node:os');
          const path = await import('node:path');
          const trusted = agent.getConfig().skillsOptions?.trusted ?? false;
          const locationDir = useGlobal
            ? path.join(os.homedir(), '.tiny-cli', 'agent', 'skills')
            : useProject || trusted
              ? path.join(process.cwd(), '.tiny-cli', 'skills')
              : path.join(os.homedir(), '.tiny-cli', 'agent', 'skills');
          agentApi.submitMessage(
            `Use the create-skill skill to create a skill named "${skillName}" with description "${description}" in ${locationDir}.`
          );
          addSystemLog(`Asking the agent to scaffold skill "${skillName}" in ${locationDir}…`);
          return true;
        }

        default:
          addErrorLog(`Unknown command: /${cmd}`);
          return true;
      }
    },
    [agent, sessionManager, session, exit, addSystemLog, addErrorLog, agentApi],
  );

  // ── Input submission handler ──
  const handleSubmit = useCallback(
    async (text: string) => {
      // Slash command?
      if (text.startsWith('/')) {
        await handleSlashCommand(text);
        return;
      }

      // Bare "continue" triggers structured plan execution
      if (text.toLowerCase() === 'continue') {
        agentApi.executePlan();
        return;
      }

      // Hydrate @file mentions then submit. The hydrated text (with
      // <file> blocks) goes to the model; the original text (with @path
      // mentions) is what gets displayed in the log.
      const display = text.replace(/\[@([^\]]+)\]/g, '@$1');
      try {
        const hydrated = await hydrateMessage(text);
        agentApi.submitMessage(hydrated, display);
      } catch {
        agentApi.submitMessage(text, display);
      }
    },
    [handleSlashCommand, agentApi],
  );

  // ── Selector overlay: accept / dismiss ──
  const acceptSelector = useCallback(
    async (selectedIndex: number) => {
      const sel = stateRef.current.pendingSelector;
      if (!sel) return;
      const raw = sel.items[selectedIndex];
      const chosen = typeof raw === 'string' ? raw : raw?.value ?? raw?.label;
      dispatch({ type: 'CLOSE_SELECTOR' });

      if (!chosen) return;

      switch (sel.kind) {
        case 'model': {
          agent.updateConfig({ model: chosen });
          const updated = agent.getConfig();
          dispatch({ type: 'SET_CONFIG', config: updated });
          addSystemLog(`Model updated to: ${chosen}`);
          break;
        }
        case 'mode': {
          const newMode = chosen as 'notify' | 'auto-edit' | 'auto';
          const c = agent.getConfig();
          c.permissionMode = newMode;
          agent.updateConfig(c);
          session.metadata.permissionMode = newMode;
          try {
            await sessionManager.saveSession(session);
          } catch {
            // ignore
          }
          dispatch({ type: 'SET_PERMISSION_MODE', mode: newMode });
          addSystemLog(`Permission mode set to: ${newMode}`);
          break;
        }
        case 'session': {
          const newSession = await sessionManager.loadSession(chosen);
          if (newSession) {
            agent.setSessionId(chosen);
            agent.setHistory(newSession.messages);
            dispatch({ type: 'SET_SESSION_ID', sessionId: chosen });
            dispatch({ type: 'CLEAR_LOG' });
            addSystemLog(`Loaded session: ${chosen}`);
            for (const m of newSession.messages) {
              if (m.role === 'user' || m.role === 'assistant') {
                addLog({ type: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
              }
            }
          } else {
            addErrorLog(`Session not found: ${chosen}`);
          }
          break;
        }
        case 'mcp': {
          const srv = (agent.getConfig().mcpServers || []).find((s) => s.name === chosen);
          if (srv) {
            addSystemLog(`Reconnecting to ${chosen}...`);
            try {
              await agent.mcpManager.reconnect(srv);
              addSystemLog(`Reconnected to ${chosen}.`);
            } catch (err: any) {
              addErrorLog(`Failed to reconnect to ${chosen}: ${err.message}`);
            }
          } else {
            addErrorLog(`MCP server not found: ${chosen}`);
          }
          break;
        }
      }
    },
    [agent, sessionManager, session, addSystemLog, addErrorLog],
  );

  // ── Selector overlay keyboard navigation ──
  // selectedIndex is mirrored in a ref so batched keystrokes (arrows and
  // Enter arriving in one stdin chunk, before React re-renders) operate
  // on the freshest value instead of a stale closure. A new selector
  // object (different identity) re-syncs the mirror.
  const selectorIndexRef = useRef(0);
  const selectorObjRef = useRef<PendingSelector | null>(null);
  useInput(
    (_input, key) => {
      const sel = stateRef.current.pendingSelector;
      if (!sel) return;

      if (selectorObjRef.current !== sel) {
        selectorObjRef.current = sel;
        selectorIndexRef.current = sel.selectedIndex;
      }

      if (key.upArrow || key.downArrow) {
        const max = sel.items.length - 1;
        const cur = selectorIndexRef.current;
        const next = key.upArrow ? (cur <= 0 ? max : cur - 1) : cur >= max ? 0 : cur + 1;
        selectorIndexRef.current = next;
        dispatch({ type: 'PATCH', patch: { pendingSelector: { ...sel, selectedIndex: next } } });
      } else if (key.return) {
        acceptSelector(selectorIndexRef.current);
      } else if (key.escape) {
        dispatch({ type: 'CLOSE_SELECTOR' });
      }
    },
    // Only active while a selector overlay is open (yields to the
    // conversation pane otherwise).
    { isActive: !!state.pendingSelector },
  );

  // ── Global keyboard: Escape aborts, Ctrl+C (×2) / Ctrl+D exit ──
  // First Ctrl+C arms the exit (and says so); a second Ctrl+C within
  // CTRL_C_WINDOW_MS exits. This guards against reflexively killing the
  // session mid-turn — a single stray Ctrl+C would otherwise destroy an
  // in-flight agent run and lose the "queued messages" the user typed.
  const lastCtrlCRef = useRef(0);
  const CTRL_C_WINDOW_MS = 2000;

  useInput((input, key) => {
    // Don't intercept when an overlay/modal is handling its own input.
    if (stateRef.current.pendingApproval) return;
    if (stateRef.current.pendingRecovery) return;
    if (stateRef.current.pendingSelector) return;
    // Ctrl+R search owns Esc (cancel search) — must not abort the turn.
    if (searchActiveRef.current) return;
    // Browse mode owns Esc too (exit browse back to typing).
    if (browseModeRef.current) return;

    // Ctrl+S (or its remap) opens the session switcher.
    if (matchesBinding(input, key, bindingFor('sessionSwitcher'))) {
      void handleSlashCommand('/session');
      return;
    }

    if (matchesBinding(input, key, bindingFor('abort')) && stateRef.current.agentState === 'running') {
      agentApi.abortCurrentRun();
    }

    // Ctrl+D exits immediately; Ctrl+C needs a second press.
    if (key.ctrl && input === 'd') {
      agent.destroy().finally(() => exit());
    } else if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (now - lastCtrlCRef.current <= CTRL_C_WINDOW_MS) {
        agent.destroy().finally(() => exit());
      } else {
        lastCtrlCRef.current = now;
        addSystemLog('Press Ctrl+C again to exit (Ctrl+D exits immediately, Esc aborts the current turn).');
      }
    }
  });

  // ── Initial banner ──
  const initialisedRef = useRef(false);
  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;
    dispatch({
      type: 'ADD_LOG',
      entry: {
        type: 'system',
        content: `🚀 tiny-cli ready — Model: ${config.model} @ ${config.endpoint}`,
      },
    });
    dispatch({
      type: 'ADD_LOG',
      entry: {
        type: 'system',
        content: `Session: ${sessionId} | Mode: ${initialMode} | Permission: ${session.metadata.permissionMode || config.permissionMode || 'notify'}`,
      },
    });
    dispatch({
      type: 'ADD_LOG',
      entry: {
        type: 'system',
        content: 'Type a message below, or use / for commands, @ to mention files.',
      },
    });
  }, []);

  // ── Render ──
  const config_ = state._config ?? config;
  const sessionId_ = state._sessionId ?? sessionId;
  const permissionMode = state._permissionMode ?? session.metadata.permissionMode ?? config.permissionMode ?? 'notify';

  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;
  const terminalColumns = stdout?.columns ?? 80;

  // The conversation pane may consume keys only when no higher-priority
  // consumer is open (key-precedence ladder: modal > selector > autocomplete).
  const paneKeysActive =
    !state.pendingApproval &&
    !state.pendingRecovery &&
    !state.pendingSelector &&
    !state.showAutocomplete &&
    !mentionActive &&
    !searchActive;

  // Fixed integer height budget (no percentages / flexGrow). A concrete
  // row budget per region makes the layout stable: only the message list's
  // children change between renders, never the overall structure, which
  // eliminates the full-screen reflow/flicker on each new message.
  //
  //   terminalRows
  //   - 1  (input box)
  //   - 5  (bottom agent-details box: Header 2 + StatusBar 1 + border 2)
  //   = top conversation box (its border + a 1-line status strip + the log)
  const bottomBoxHeight = 5;
  const inputHeight = 1;
  const topBoxHeight = Math.max(8, terminalRows - inputHeight - bottomBoxHeight);
  // Inside the top box: border (2) + reserved status strip (1) = 3 chrome rows.
  const paneMaxHeight = Math.max(4, topBoxHeight - 3);

  // Status strip content (queue / spinner / blank) — always 1 line so its
  // presence never reflows the message log above it.
  const statusLine = state.agentState === 'running' && state.spinnerText
    ? state.spinnerText
    : state.messageQueue.length > 0
      ? `📬 ${state.messageQueue.length} queued message${state.messageQueue.length !== 1 ? 's' : ''}`
      : '';

  // Handler for selector popover selections (model/mode/session/mcp)
  const handleSelectorAccept = (kind: SelectorKind, value: string) => {
    switch (kind) {
      case 'model':
        handleSlashCommand(`/model ${value}`);
        break;
      case 'mode':
        handleSlashCommand(`/mode ${value}`);
        break;
      case 'session':
        handleSlashCommand(`/session ${value}`);
        break;
      case 'mcp':
        handleSlashCommand(`/mcp ${value}`);
        break;
      case 'skill': {
        // Toggle the selected skill in config.activeSkills. The full body
        // of every active skill is injected into the system prompt on each
        // run (agent.ts), so this survives compaction and reloads.
        const cfg = agent.getConfig();
        const active = new Set(cfg.activeSkills ?? []);
        if (active.has(value)) {
          active.delete(value);
          addSystemLog(`Skill deactivated: ${value}`);
        } else {
          active.add(value);
          addSystemLog(`Skill activated: ${value} (injected into system prompt)`);
        }
        const updated = { ...cfg, activeSkills: [...active] };
        agent.updateConfig(updated);
        import('../config.js').then(({ saveConfig }) => saveConfig(updated)).catch(() => {});
        break;
      }
    }
    dispatch({ type: 'PATCH', patch: { pendingSelector: null } });
  };

  return (
    <Box flexDirection="column" height={terminalRows}>
      {/* TOP: conversation pane — fixed height, scrollable, collapsible.
          Border stays themed and quiet; only alarms (pending modal,
          error) override it. */}
      <Box
        flexDirection="column"
        height={topBoxHeight}
        borderStyle="round"
        borderColor={
          state.pendingApproval || state.pendingRecovery ? theme.warning
          : state.agentState === 'error' ? theme.error
          : theme.border
        }
      >
        <MessageLog
          ref={paneRef}
          entries={state.log}
          active={paneKeysActive}
          maxHeight={paneMaxHeight}
          browseMode={browseMode}
          onBrowseModeChange={setBrowseMode}
          agentRunning={state.agentState === 'running' || state.agentState === 'awaiting_approval'}
        />
        {/* Reserved 1-line status strip — constant height, no reflow. */}
        <Box height={1}>
          {state.agentState === 'running' && state.spinnerText ? (
            <Spinner text={statusLine} />
          ) : statusLine ? (
            <Text dimColor color={theme.warning}>
              {' '}
              {statusLine}
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      </Box>

      {/* MIDDLE: input box — always mounted; unmounting would tear down
          useInput's raw-mode cleanup and kill all keyboard input. In browse
          mode we show the banner and blur the input so the conversation pane
          owns arrows/Tab without key conflicts; also blurred while a modal
          overlay owns the keyboard (its quick-select keys y/s/n/a must not
          land in the text draft). */}
      {browseMode ? (
        <Box height={inputHeight}>
          <Text dimColor> BROWSE MODE — Esc or Enter to resume typing</Text>
        </Box>
      ) : null}
      <Box display={browseMode ? 'none' : 'flex'}>
        <InputBox
          mode={state.mode}
          agentState={state.agentState}
          onSubmit={handleSubmit}
          showAutocomplete={state.showAutocomplete}
          fileIndex={fileIndex}
          onMentionActiveChange={setMentionActive}
          onSearchActiveChange={setSearchActive}
          focus={!browseMode && !state.pendingApproval && !state.pendingRecovery && !state.pendingSelector}
        />
      </Box>

      {/* BOTTOM: agent details (banner + Model/Session + status) — fixed height.
          Border colour comes straight from the theme (borderStatus), so each
          sample theme gives this panel a distinct look. */}
      <Box
        flexDirection="column"
        height={bottomBoxHeight}
        borderStyle="single"
        borderColor={theme.borderStatus}
      >
        <Header model={config_.model} endpoint={config_.endpoint} sessionId={sessionId_} />
        <StatusBar
          mode={state.mode}
          contextStats={state.contextStats}
          permissionMode={permissionMode}
        />
      </Box>

      {/* Approval modal overlay */}
      {state.pendingApproval ? (
        <ApprovalModal toolCall={state.pendingApproval} onSelect={agentApi.resolveApproval} />
      ) : null}

      {/* Recovery modal overlay (task not marked complete) */}
      {state.pendingRecovery ? (
        <RecoveryModal recovery={state.pendingRecovery} onSelect={agentApi.resolveRecovery} />
      ) : null}

      {/* Inline selector overlay (model / mode / session picker) —
          absolutely positioned so it floats above the input row without
          reserving rows in the flex layout. Bottom-anchored: it grows
          upward from just above the input (bottom box 5 + input 1 + gap 1). */}
      {state.pendingSelector ? (
        <Box position="absolute" bottom={bottomBoxHeight + inputHeight + 1} left={2} width={terminalColumns - 4}>
          <AutocompletePopover
            items={state.pendingSelector.items}
            title={state.pendingSelector.title}
            selectedIndex={state.pendingSelector.selectedIndex}
            onSelect={(value) => handleSelectorAccept(state.pendingSelector!.kind, value)}
            onDismiss={() => dispatch({ type: 'PATCH', patch: { pendingSelector: null } })}
          />
        </Box>
      ) : null}

      {/* Mouse-wheel → conversation pane scroll (opt-in via /mouse) */}
      <StdinMouseBridge
        enabled={state.mouseEnabled}
        onWheel={(d) => paneRef.current?.wheel(d)}
      />
    </Box>
  );
}
