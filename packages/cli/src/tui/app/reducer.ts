import type React from 'react';
import type { AgentConfig } from '@tiny-cli/core';
import type { TuiState, TuiMode, LogEntry, PendingSelector } from '../state.js';
import type { NewLogEntry } from '../hooks/useAgent.js';

export type Action =
  | { type: 'PATCH'; patch: Partial<TuiState> }
  | { type: 'ADD_LOG'; entry: NewLogEntry }
  | { type: 'SET_MODE'; mode: TuiMode }
  | { type: 'CLEAR_LOG' }
  | { type: 'SET_PERMISSION_MODE'; mode: 'notify' | 'auto-edit' | 'auto' }
  | { type: 'SET_CONFIG'; config: AgentConfig }
  | { type: 'SET_SESSION_ID'; sessionId: string }
  | { type: 'OPEN_SELECTOR'; selector: PendingSelector }
  | { type: 'CLOSE_SELECTOR' }
  | { type: 'MOVE_SELECTOR'; direction: 'up' | 'down' };

export type AppDispatch = React.Dispatch<Action>;

let logIdCounter = 0;

export function reducer(state: TuiState, action: Action): TuiState {
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

export function createInitialState(
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
    pendingQuestions: null,
    messageQueue: [],
    spinnerText: '',
    showAutocomplete: false,
    autocompleteItems: [],
    autocompleteSelected: 0,
    contextStats: { tokens: 0, characters: 0 },
    pendingRecovery: null,
    planExecuting: false,
    pendingPlanConfirm: null,
    pendingSelector: null,
    _config: config,
    _sessionId: sessionId,
    _permissionMode: permissionMode,
  };
}
