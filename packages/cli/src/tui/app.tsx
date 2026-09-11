import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput, useStdout } from "./compat.js";
import { logTrace, SessionManager } from "@tiny-cli/core";
import type { Agent, Session, AgentConfig } from "@tiny-cli/core";

import type {
  TuiState,
  TuiMode,
  LogEntry,
  ContextStats,
  PendingSelector,
  SelectorKind,
} from "./state.js";
import AutocompletePopover from "./components/AutocompletePopover.js";
import Header from "./components/Header.js";
import StatusBar from "./components/StatusBar.js";
import MessageLog, { type MessageLogHandle } from "./components/MessageLog.js";
import Spinner from "./components/Spinner.js";
import { StreamProvider } from "./components/StreamProvider.js";
import { StreamStore } from "./streamStore.js";
import InputBox, { MENTION_POPOVER_ROWS } from "./components/InputBox.js";
import ApprovalModal from "./components/ApprovalModal.js";
import QuestionnaireModal from "./components/QuestionnaireModal.js";
import RecoveryModal from "./components/RecoveryModal.js";
import PlanConfirmModal from "./components/PlanConfirmModal.js";

import { useConsoleCapture } from "./hooks/useConsoleCapture.js";
import {
  useAgent,
  type UseAgentStatePatch,
  type NewLogEntry,
} from "./hooks/useAgent.js";
import { useSubmit } from "./hooks/useSubmit.js";

import { buildFileIndex } from "../file-mention.js";
import { fetchModels } from "../commands/handlers.js";
import { SLASH_COMMANDS } from "./utils/commands.js";
import { findInLog } from "./utils/logSearch.js";
import type { Theme } from "./theme.js";
import { bindingFor, matchesBinding } from "./keybindings.js";

// ─── Initial state ─────────────────────────────────────────────────

// ─── Extracted modules (app/) ────────────────────────────────────────
// State reducer + initial state: app/reducer.ts. Session replay helpers:
// app/sessionLoad.ts. Skill commands: app/skills.ts.
import {
  reducer,
  createInitialState,
  type Action,
  type AppDispatch,
} from "./app/reducer.js";
import {
  relativeTime,
  createReplaySessionMessages,
} from "./app/sessionLoad.js";
import { createSlashCommands } from "./app/slashCommands.js";

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
}: AppProps): React.ReactNode {
  const { exit } = useApp();

  const [state, dispatch] = useReducer(
    reducer,
    createInitialState(
      config,
      sessionId,
      initialMode,
      session.metadata.permissionMode || config.permissionMode || "notify",
    ),
  );

  // ── Refs for values needed inside callbacks ──
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Ref to the conversation pane (scroll control from global keys) ──
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
    dispatch({ type: "PATCH", patch: patch as Partial<TuiState> });
  }, []);

  // ── Log helpers ──
  const addLog = useCallback((entry: NewLogEntry) => {
    dispatch({ type: "ADD_LOG", entry });
  }, []);

  // ── Streaming store ──
  // Live thinking/response deltas and spinner-text changes live in this
  // external store (inside the log-pane subtree), so a delta never
  // re-renders the whole App. When a phase ends, the store hands the full
  // text back here — one ADD_LOG commit per phase.
  const [streamStore] = React.useState(() => new StreamStore());
  React.useEffect(() => {
    streamStore.onCommit = (type: "reasoning" | "assistant", text: string) => {
      addLog({ type, content: text });
    };
    return () => {
      streamStore.onCommit = null;
    };
  }, [streamStore, addLog]);

  const addSystemLog = useCallback((content: string) => {
    dispatch({ type: "ADD_LOG", entry: { type: "system", content } });
  }, []);

  const addErrorLog = useCallback((content: string) => {
    dispatch({ type: "ADD_LOG", entry: { type: "error", content } });
  }, []);

  /**
   * Replay persisted session messages into the transcript log. Compaction
   * summaries surface as a system entry, tool-only assistant messages (no
   * text content) as compact tool markers — otherwise a compacted session
   * loads as a wall of empty agent bubbles.
   */
  const replaySessionMessages = createReplaySessionMessages({
    addLog,
    addSystemLog,
  });

  // ── Console capture ──
  useConsoleCapture((entry) => {
    dispatch({ type: "ADD_LOG", entry });
  });

  // ── Agent hook ──
  const agentApi = useAgent({
    agent,
    sessionManager,
    sessionId: state._sessionId ?? sessionId,
    setState: setStateForAgent,
    addLog,
    getMode: () => stateRef.current.mode,
    setMode: (mode) => dispatch({ type: "SET_MODE", mode }),
    streamStore,
  });

  /** True when the active session's plan has at least one `- [ ]` task. */
  // ── Slash command handling ──
  // ── Slash command handling ──
  // ── Slash command handling (app/slashCommands.ts) ──
  const handleSlashCommand = createSlashCommands({
    agent,
    sessionManager,
    session,
    sessionId: state._sessionId ?? sessionId,
    exit,
    dispatch,
    stateRef,
    addSystemLog,
    addErrorLog,
    agentApi,
    replaySessionMessages,
    setBrowseMode,
    paneRef,
  });

  // ── Input submission handler (hooks/useSubmit.ts) ──
  const handleSubmit = useSubmit({
    sessionId,
    stateRef,
    paneRef,
    agentApi,
    handleSlashCommand,
  });

  // ── Selector overlay: accept / dismiss ──
  const acceptSelector = useCallback(
    async (selectedIndex: number) => {
      const sel = stateRef.current.pendingSelector;
      if (!sel) return;
      const raw = sel.items[selectedIndex];
      const chosen = typeof raw === "string" ? raw : (raw?.value ?? raw?.label);
      dispatch({ type: "CLOSE_SELECTOR" });

      if (!chosen) return;

      switch (sel.kind) {
        case "model": {
          agent.updateConfig({ model: chosen });
          const updated = agent.getConfig();
          dispatch({ type: "SET_CONFIG", config: updated });
          addSystemLog(`Model updated to: ${chosen}`);
          break;
        }
        case "thinking": {
          const cfg = agent.getConfig();
          const level = chosen as "off" | "low" | "medium" | "high";
          const updated = { ...cfg, thinkingLevel: level };
          agent.updateConfig({ thinkingLevel: level });
          dispatch({ type: "SET_CONFIG", config: updated });
          import("../config.js")
            .then(({ saveConfig }) => saveConfig(updated))
            .catch((e) => {
              logTrace(`[trace] saveConfig failed: ${e?.name} ${e?.message}`);
            });
          try {
            addSystemLog(`Thinking level set to: ${level}`);
          } catch (e) {
            logTrace(`[trace] addSystemLog failed: ${e}`);
          }

          break;
        }
        case "mode": {
          const newMode = chosen as "notify" | "auto-edit" | "auto";
          const c = agent.getConfig();
          c.permissionMode = newMode;
          agent.updateConfig(c);
          session.metadata.permissionMode = newMode;
          try {
            await sessionManager.saveSession(session);
          } catch (e) {
            logTrace(`[trace] saveSession failed: ${e}`);
          }
          dispatch({ type: "SET_PERMISSION_MODE", mode: newMode });
          addSystemLog(`Permission mode set to: ${newMode}`);
          break;
        }
        case "session": {
          const newSession = await sessionManager.loadSession(chosen);
          if (newSession) {
            agent.setSessionId(chosen);
            agent.setHistory(newSession.messages);
            dispatch({ type: "SET_SESSION_ID", sessionId: chosen });
            dispatch({ type: "CLEAR_LOG" });
            addSystemLog(`Loaded session: ${chosen}`);
            replaySessionMessages(newSession.messages);
          } else {
            addErrorLog(`Session not found: ${chosen}`);
          }
          break;
        }
        case "mcp": {
          // Second level: pick an action for the chosen server (mirrors the
          // old REPL's inquirer two-step /mcp flow).
          dispatch({
            type: "OPEN_SELECTOR",
            selector: {
              kind: "mcp-action",
              title: `Action for ${chosen}`,
              items: ["Reconnect", "Disconnect", "List tools"],
              selectedIndex: 0,
              context: chosen,
            },
          });
          break;
        }
        case "mcp-action": {
          const name = sel.context;
          if (!name) break;
          if (chosen === "Reconnect") {
            const srv = (agent.getConfig().mcpServers || []).find(
              (s) => s.name === name,
            );
            if (srv) {
              addSystemLog(`Reconnecting to ${name}...`);
              try {
                await agent.mcpManager.reconnect(srv);
                addSystemLog(`Reconnected to ${name}.`);
              } catch (err: any) {
                addErrorLog(`Failed to reconnect to ${name}: ${err.message}`);
              }
            }
          } else if (chosen === "Disconnect") {
            await agent.mcpManager.disconnect(name);
            addSystemLog(`Disconnected ${name}.`);
          } else if (chosen === "List tools") {
            const tools = agent.mcpManager.getTools(name);
            addSystemLog(`Tools for ${name}:`);
            if (tools.length === 0) {
              dispatch({
                type: "ADD_LOG",
                entry: {
                  type: "info",
                  content: "  No tools found or server disconnected.",
                },
              });
            }
            for (const t of tools) {
              dispatch({
                type: "ADD_LOG",
                entry: { type: "info", content: `  ${t.definition.name}` },
              });
            }
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
      logTrace(`[trace] selector overlay input: ${JSON.stringify(_input)} key=${JSON.stringify(key)} sel=${sel ? JSON.stringify(sel) : 'null'}`);
      if (!sel) return;

      if (selectorObjRef.current !== sel) {
        selectorObjRef.current = sel;
        selectorIndexRef.current = sel.selectedIndex;
      }

      if (key.upArrow || key.downArrow) {
        const max = sel.items.length - 1;
        const cur = selectorIndexRef.current;
        const next = key.upArrow
          ? cur <= 0
            ? max
            : cur - 1
          : cur >= max
            ? 0
            : cur + 1;
        selectorIndexRef.current = next;
        dispatch({
          type: "PATCH",
          patch: { pendingSelector: { ...sel, selectedIndex: next } },
        });
      } else if (key.return) {
        acceptSelector(selectorIndexRef.current);
      } else if (key.escape) {
        dispatch({ type: "CLOSE_SELECTOR" });
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
    try {
    // Don't intercept when an overlay/modal is handling its own input.
    if (stateRef.current.pendingApproval) return;
    if (stateRef.current.pendingQuestions) return;
    if (stateRef.current.pendingRecovery) return;
    if (stateRef.current.pendingPlanConfirm) return;
    if (stateRef.current.pendingSelector) return;
    // Ctrl+R search owns Esc (cancel search) — must not abort the turn.
    if (searchActiveRef.current) return;
    // Browse mode owns Esc too (exit browse back to typing).
    if (browseModeRef.current) return;

    // Ctrl+S (or its remap) opens the session switcher.
    if (matchesBinding(input, key, bindingFor("sessionSwitcher"))) {
      void handleSlashCommand("/session");
      return;
    }

    if (
      matchesBinding(input, key, bindingFor("abort")) &&
      stateRef.current.agentState === "running"
    ) {
      try{
        agentApi.abortCurrentRun();
      } catch (e) {
        logTrace(`[trace] abortCurrentRun threw: ${(e as Error)?.name}: ${(e as Error)?.message}\n${(e as Error)?.stack ?? ''}`);
      }
      return;
      

    }

    // Ctrl+D exits immediately; Ctrl+C needs a second press.
    if (key.ctrl && input === "d") {
      agent.destroy().finally(() => exit());
    } else if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current <= CTRL_C_WINDOW_MS) {
        agent.destroy().finally(() => exit());
      } else {
        lastCtrlCRef.current = now;
        addSystemLog(
          "Press Ctrl+C again to exit (Ctrl+D exits immediately, Esc aborts the current turn).",
        );
      }
    }
    } catch (err: unknown) {
      const e = err as Error;
      logTrace(`[trace] app useInput threw: ${e?.name}: ${e?.message}\ninput=${JSON.stringify(input)} key=${JSON.stringify(key)}\n${e?.stack ?? ''}`);
      throw err;
    }
  });

  // ── Initial banner ──
  const initialisedRef = useRef(false);
  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;
    dispatch({
      type: "ADD_LOG",
      entry: {
        type: "system",
        content: `🚀 tiny-cli ready — Model: ${config.model} @ ${config.endpoint}`,
      },
    });
    dispatch({
      type: "ADD_LOG",
      entry: {
        type: "system",
        content: `Session: ${sessionId} | Mode: ${initialMode} | Permission: ${session.metadata.permissionMode || config.permissionMode || "notify"}`,
      },
    });
    dispatch({
      type: "ADD_LOG",
      entry: {
        type: "system",
        content:
          "Type a message below, or use / for commands, @ to mention files.",
      },
    });
  }, []);

  // ── Render ──
  const config_ = state._config ?? config;
  const sessionId_ = state._sessionId ?? sessionId;
  const permissionMode =
    state._permissionMode ??
    session.metadata.permissionMode ??
    config.permissionMode ??
    "notify";

  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;
  const terminalColumns = stdout?.columns ?? 80;

  // The conversation pane may consume keys only when no higher-priority
  // consumer is open (key-precedence ladder: modal > selector > autocomplete).
  const paneKeysActive =
    !state.pendingApproval &&
    !state.pendingQuestions &&
    !state.pendingRecovery &&
    !state.pendingPlanConfirm &&
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
  // Multi-line draft display: the input grows with the draft (Shift+Enter),
  // capped so a giant paste-chip draft can't eat the screen. Editing behavior
  // is unchanged — only the rendered height and the pane budget below.
  const [draftLines, setDraftLines] = useState(1);
  const inputHeight = Math.min(6, draftLines);
  // While the @file-mention (or /command) picker is open, the popover block
  // adds MENTION_POPOVER_ROWS rows below the input row. The root column is
  // height=terminalRows, so the conversation pane must shrink by the same
  // amount or Yoga clips interior rows of the overflowing column (missing
  // popover rows / garbled list).
  const popoverRows = mentionActive ? MENTION_POPOVER_ROWS : 0;
  const topBoxHeight = Math.max(
    8,
    terminalRows - inputHeight - bottomBoxHeight - popoverRows,
  );
  // Inside the top box: border (2) + reserved status strip (1) = 3 chrome rows.
  const paneMaxHeight = Math.max(4, topBoxHeight - 3);

  // Status strip content now lives inside MessageLog (SpinnerStrip),
  // driven by the streaming store — text changes there don't re-render App.

  // Handler for selector popover selections (model/mode/session/mcp)
  const handleSelectorAccept = (kind: SelectorKind, value: string) => {
    switch (kind) {
      case "model":
        handleSlashCommand(`/model ${value}`);
        break;
      case "mode":
        handleSlashCommand(`/mode ${value}`);
        break;
      case "session":
        handleSlashCommand(`/session ${value}`);
        break;
      case "mcp":
        handleSlashCommand(`/mcp ${value}`);
        break;
      case "thinking":
        handleSlashCommand(`/thinking ${value}`);
        break;
      case "skill": {
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
          addSystemLog(
            `Skill activated: ${value} (injected into system prompt)`,
          );
        }
        const updated = { ...cfg, activeSkills: [...active] };
        agent.updateConfig(updated);
        import("../config.js")
          .then(({ saveConfig }) => saveConfig(updated))
          .catch(() => {});
        break;
      }
    }
    dispatch({ type: "PATCH", patch: { pendingSelector: null } });
  };

  return (
    <StreamProvider store={streamStore}>
      <Box flexDirection="column" height={terminalRows}>
        {/* TOP: conversation pane — fixed height, scrollable, collapsible.
          Border stays themed and quiet; only alarms (pending modal,
          error) override it. */}
        <Box
          flexDirection="column"
          height={topBoxHeight}
          borderStyle="round"
          borderColor={
            state.pendingApproval ||
            state.pendingQuestions ||
            state.pendingRecovery
              ? theme.warning
              : state.agentState === "error"
                ? theme.error
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
            agentRunning={
              state.agentState === "running" ||
              state.agentState === "awaiting_approval"
            }
            queuedCount={state.messageQueue.length}
          />
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
        <Box display={browseMode ? "none" : "flex"}>
          <InputBox
            mode={state.mode}
            agentState={state.agentState}
            onSubmit={handleSubmit}
            showAutocomplete={state.showAutocomplete}
            fileIndex={fileIndex}
            onMentionActiveChange={setMentionActive}
            onSearchActiveChange={setSearchActive}
            onDraftLinesChange={setDraftLines}
            focus={
              !browseMode &&
              !state.pendingApproval &&
              !state.pendingQuestions &&
              !state.pendingRecovery &&
              !state.pendingPlanConfirm &&
              !state.pendingSelector
            }
            dispatch={dispatch}
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
          <Header
            model={config_.model}
            endpoint={config_.endpoint}
            sessionId={sessionId_}
          />
          <StatusBar
            mode={state.mode}
            contextStats={state.contextStats}
            permissionMode={permissionMode}
            compactThreshold={config_.compactionThresholdTokens}
            thinkingLevel={config_.thinkingLevel}
            cwd={process.cwd()}
          />
        </Box>

        {/* Approval modal overlay */}
        {state.pendingApproval ? (
          <ApprovalModal
            toolCall={state.pendingApproval}
            onSelect={agentApi.resolveApproval}
          />
        ) : null}

        {/* Questionnaire modal overlay (agent asked the user) */}
        {state.pendingQuestions ? (
          <QuestionnaireModal
            questionnaire={state.pendingQuestions}
            onDone={agentApi.resolveQuestionnaire}
          />
        ) : null}

        {/* Recovery modal overlay (task not marked complete) */}
        {state.pendingRecovery ? (
          <RecoveryModal
            recovery={state.pendingRecovery}
            onSelect={agentApi.resolveRecovery}
          />
        ) : null}

        {/* Plan-execute confirm overlay (plan turn finished) */}
        {state.pendingPlanConfirm ? (
          <PlanConfirmModal
            taskCount={state.pendingPlanConfirm.taskCount}
            onSelect={agentApi.resolvePlanConfirm}
          />
        ) : null}

        {/* Inline selector overlay (model / mode / session picker) —
          absolutely positioned so it floats above the input row without
          reserving rows in the flex layout. Bottom-anchored: it grows
          upward from just above the input (bottom box 5 + input 1 + gap 1). */}
        {state.pendingSelector ? (
          <Box
            position="absolute"
            bottom={bottomBoxHeight + inputHeight + 1}
            left={2}
            width={terminalColumns - 4}
          >
            <AutocompletePopover
              items={state.pendingSelector.items}
              title={state.pendingSelector.title}
              selectedIndex={state.pendingSelector.selectedIndex}
              onSelect={(value) =>
                handleSelectorAccept(state.pendingSelector!.kind, value)
              }
              onDismiss={() =>
                dispatch({ type: "PATCH", patch: { pendingSelector: null } })
              }
            />
          </Box>
        ) : null}
      </Box>
    </StreamProvider>
  );
}
