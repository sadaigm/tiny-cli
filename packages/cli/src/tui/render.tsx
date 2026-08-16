import React from 'react';
import { render } from 'ink';
import type { Agent, SessionManager, Session, AgentConfig } from '@tiny-cli/core';
import { setLogLevel, logError } from '@tiny-cli/core';
import App from './app.js';
import type { TuiMode } from './state.js';
import { loadTheme, setTheme } from './theme.js';
import { loadKeybindings, setKeybindings } from './keybindings.js';

/**
 * Props passed from `index.ts` when booting the TUI.
 */
export interface StartTuiOptions {
  agent: Agent;
  sessionManager: SessionManager;
  session: Session;
  config: AgentConfig;
  sessionId: string;
  mode: TuiMode;
}

/**
 * Mount the Ink-based TUI and block until the app exits.
 *
 * This is the entry point used by `index.ts` when no headless query
 * is provided.  The returned promise resolves when Ink's render
 * instance reports it has been unmounted (i.e. the user typed
 * `/exit` or pressed Ctrl+C).
 *
 * Cleanup is handled in two layers:
 * 1. Ink's `unmount()` is called when the `<App>` triggers `exit()`
 *    via `useApp().exit()`.
 * 2. The Ink `onExit` callback resolves the promise, returning
 *    control to the caller.
 */
export async function startTui(opts: StartTuiOptions): Promise<void> {
  // Uncaught failures inside the Ink tree would otherwise vanish with the
  // alternate-screen restore — dump them to the log file before dying.
  process.on('uncaughtException', (err) => {
    logError(`uncaughtException: ${err.message}\n${err.stack ?? ''}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logError(`unhandledRejection: ${String(reason)}`);
  });
  return new Promise<void>((resolve) => {
    // Theme loads synchronously before the first render so there is no
    // default-palette flash (a bad file falls back to the default theme).
    // setTheme installs it as the module singleton components read via
    // getTheme(); the prop copy is kept for the App's own direct reads.
    // Screen log level honours the config; the file log (~/.tiny-cli/tui.log)
    // always records every level regardless.
    if (opts.config.logLevel) setLogLevel(opts.config.logLevel);
    const theme = loadTheme();
    setTheme(theme);
    setKeybindings(loadKeybindings());
    const instance = render(
      React.createElement(App, {
        agent: opts.agent,
        sessionManager: opts.sessionManager,
        config: opts.config,
        sessionId: opts.sessionId,
        session: opts.session,
        initialMode: opts.mode,
        theme,
      }),
      {
        exitOnCtrlC: false, // We handle Ctrl+C inside <App> for clean shutdown
        // Kitty keyboard protocol: lets us distinguish Shift+Enter (newline)
        // from plain Enter (submit) in <TextInput>. 'auto' enables it only on
        // terminals that confirm support, with no penalty elsewhere.
        kittyKeyboard: { mode: 'auto' },
      },
    );

    instance.waitUntilExit().then(() => {
      resolve();
    });
  });
}
