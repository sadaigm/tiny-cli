// Browser stub for @tiny-cli/core. The real package pulls in node-fetch →
// fetch-blob → Node stream/fs APIs that crash ink-web's Vite optimization.
// Web mode feeds <App> a fake agent/session (see main.tsx), so the only value
// import from core that reaches the bundle is `SessionManager` (used by
// app.tsx for /session new). We stub it out; the fake agent/sessionManager in
// main.tsx handle everything else.
export class SessionManager {
  static createSession(_id) {
    return {
      metadata: { id: _id ?? 'web-session', createdAt: '', lastUpdatedAt: '' },
      messages: [],
    };
  }
}
