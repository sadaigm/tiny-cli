// Browser stub for @tiny-cli/core. The real package pulls in node-fetch →
// fetch-blob → Node stream/fs APIs that crash ink-web's Vite optimization.
// Web mode feeds <App> a fake agent/session (see main.tsx), so the only value
// imports from core that reach the bundle are `SessionManager` (app.tsx,
// useAgent), the logging helpers (render.tsx, useAgent) and
// DEFAULT_COMPACT_THRESHOLD (StatusBar). The fake agent/sessionManager in
// main.tsx handle everything else. Keep this in sync with value imports of
// '@tiny-cli/core' under src/tui.
export class SessionManager {
  static createSession(_id) {
    return {
      metadata: { id: _id ?? 'web-session', createdAt: '', lastUpdatedAt: '' },
      messages: [],
    };
  }
}

// Mirrors DEFAULT_COMPACT_THRESHOLD in core/src/compact_utils.ts.
export const DEFAULT_COMPACT_THRESHOLD = 35_000;

export function setLogLevel() {}

export function logError(...args) {
  console.error('[tiny-cli]', ...args);
}
