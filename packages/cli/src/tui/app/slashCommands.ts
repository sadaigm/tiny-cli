import React, { useCallback } from 'react';
import type { Agent, Session } from '@tiny-cli/core';
import { SessionManager } from '@tiny-cli/core';
import type { TuiState } from '../state.js';
import type { MessageLogHandle } from '../components/MessageLog.js';
import type { UseAgentApi } from '../hooks/useAgent.js';
import type { AppDispatch } from './reducer.js';
import { fetchModels } from '../../commands/handlers.js';
import { SLASH_COMMANDS } from '../utils/commands.js';
import { findInLog } from '../utils/logSearch.js';
import { relativeTime } from './sessionLoad.js';
import { runSkillCommand, listSkillsCommand, createSkillCommand } from './skills.js';

const HELP_KEY_LINES: string[] = [
  'Enter        submit · Shift+Enter newline · ↑/↓ recall input history',
  'Ctrl+R       search input history (Enter accepts · Esc cancels)',
  'Ctrl+P       browse mode (↑/↓ move · Tab expand · → enter · ← fold · y copy · Esc back)',
  'Ctrl+S       switch session (opens the /session picker)',
  'Esc          abort the running turn',
  'Ctrl+C ×2    exit (Ctrl+D exits immediately)',
  '/  @         command / file-mention pickers',
];

/**
 * Slash-command dispatch, extracted verbatim from app.tsx's
 * handleSlashCommand. Every free variable of the original closure is an
 * explicit dep of this factory.
 */
export function createSlashCommands({
  agent,
  sessionManager,
  session,
  sessionId,
  exit,
  dispatch,
  stateRef,
  addSystemLog,
  addErrorLog,
  agentApi,
  replaySessionMessages,
  setBrowseMode,
  paneRef,
}: {
  agent: Agent;
  sessionManager: SessionManager;
  session: Session;
  sessionId: string;
  exit: () => void;
  dispatch: AppDispatch;
  stateRef: React.RefObject<TuiState>;
  addSystemLog: (content: string) => void;
  addErrorLog: (content: string) => void;
  agentApi: UseAgentApi;
  replaySessionMessages: (messages: Session['messages']) => void;
  setBrowseMode: (on: boolean) => void;
  paneRef: React.RefObject<MessageLogHandle | null>;
}) {
  return useCallback(
    async (input: string): Promise<boolean> => {
      // Returns true if the command was handled
      const parts = input.slice(1).split(' ');
      const cmd = parts[0]?.toLowerCase();

      // /skill:<name> [args] — send the skill's full SKILL.md content to the agent
      if (cmd?.startsWith('skill:')) {
        return runSkillCommand(cmd, parts, agent, addErrorLog, agentApi.submitMessage);
      }

      // /skills — open a selector to activate/deactivate skills; active
      // skill bodies are injected into the system prompt on every run.
      if (cmd === 'skills') {
        return listSkillsCommand(agent, dispatch, addSystemLog, addErrorLog);
      }

      switch (cmd) {
        case 'exit':
        case 'quit': {
          try {
            const c = stateRef.current._config;
            if (c) {
              c.lastSessionId = stateRef.current._sessionId;
              const { saveConfig } = await import('../../config.js');
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

        case 'usage': {
          const { tools: counts, redirects } = agent.getToolUsageStats();
          const toolEntries = Object.entries(counts);
          const redirectEntries = Object.entries(redirects);
          if (toolEntries.length === 0 && redirectEntries.length === 0) {
            addSystemLog('No tool calls recorded yet this session.');
            return true;
          }
          addSystemLog(`Tool calls this session (${toolEntries.reduce((s, [, n]) => s + n, 0)} total):`);
          for (const [name, n] of toolEntries) {
            dispatch({ type: 'ADD_LOG', entry: { type: 'info', content: `  ${name}: ${n}` } });
          }
          if (redirectEntries.length > 0) {
            addSystemLog('Bash commands redirected to dedicated tools:');
            for (const [key, n] of redirectEntries) {
              dispatch({ type: 'ADD_LOG', entry: { type: 'info', content: `  ${key}: ${n}` } });
            }
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
              replaySessionMessages(newSession.messages);
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
          const sessionItems = (
            await Promise.all(
              sessions.map(async (s) => {
                // First user message makes the session recognisable in the list.
                const full = await sessionManager.loadSession(s.id);
                // Blank sessions (nothing ever said) are unloadable noise —
                // loading one shows an empty log. Keep them out of the list.
                if (!full || full.messages.length === 0) return null;
                const firstUser = full.messages.find((m) => m.role === 'user' && m.content);
                const preview =
                  (firstUser?.content as string | undefined)?.replace(/\s+/g, ' ').trim().slice(0, 60) ||
                  '(no user message)';
                return {
                  label: preview,
                  value: s.id,
                  description: `${relativeTime(s.lastUpdatedAt)} · ${s.id.slice(0, 8)}`,
                };
              }),
            )
          ).filter((item): item is { label: string; value: string; description: string } => item !== null);
          if (sessionItems.length === 0) {
            addSystemLog('No sessions with messages found. Use /session new to create one.');
            return true;
          }
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
            addSystemLog('Select a server to manage (or use /mcp reconnect|disconnect|tools <name>).');
            dispatch({
              type: 'OPEN_SELECTOR',
              selector: {
                kind: 'mcp',
                title: 'Select MCP Server',
                items: servers.map((s) => ({
                  label: `${s.name} (${agent.mcpManager.getStatus(s.name)}, ${agent.mcpManager.getTools(s.name).length} tools)`,
                  value: s.name,
                })),
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
              // The result line is logged by the onCompaction subscription
              // in useAgent — don't log it twice.
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

        case 'create-skill':
          return createSkillCommand(parts, agent, agentApi.submitMessage, addSystemLog, addErrorLog);

        default:
          addErrorLog(`Unknown command: /${cmd}`);
          return true;
      }
    },
    [agent, sessionManager, session, exit, addSystemLog, addErrorLog, agentApi],
  );

}
