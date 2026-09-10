import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { Agent, SessionManager, Session, AgentConfig } from '@tiny-cli/core';
import { setLogLevel, logError } from '@tiny-cli/core';
import App from './app.js';
import { AppExitProvider } from './compat.js';
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
 * Mount the OpenTUI-based TUI and block until the app exits.
 *
 * The renderer is created and destroyed **only** here (the single-owner rule
 * from OpenTUI's lifecycle docs). Every shutdown path funnels into
 * `shutdown()`: the `<App>` exit callback (`useApp().exit()` via
 * `AppExitProvider`), SIGINT/SIGTERM fallbacks, and external
 * `renderer.destroy()`.
 */
export async function startTui(opts: StartTuiOptions): Promise<void> {
  // Uncaught failures inside the TUI tree would otherwise vanish with the
  // terminal restore — dump them to the log file before dying.
  // OpenTUI's keyhandler catches listener errors and reports them via
  // console.error — which the renderer then paints as an on-screen error
  // panel. Capture those to the log file too (message + real stack), since
  // the panel's own stack attribution is unreliable.
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const err = args.find((a): a is Error => a instanceof Error);
    if (err) {
      logError(`console.error: ${err.name}: ${err.message}\n${err.stack ?? '(no stack)'}`);
    } else {
      logError(`console.error: ${args.map((a) => String(a)).join(' ')}`);
    }
    origConsoleError(...args);
  };

  process.on('uncaughtException', (err) => {
    logError(`uncaughtException: ${err.message}\n${err.stack ?? ''}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const r = reason as any;
    // User aborts (Esc) reject in-flight fetches; some paths (detached
    // stream readers) escape without a catch. Expected — trace, not ERROR.
    if (r?.name === 'AbortError') return;
    // Walk the cause chain — the top-level reason often wraps the original
    // failure (fetch abort, tool error) that the surfaced message hides.
    const causes: string[] = [];
    let c = r?.cause;
    while (c && causes.length < 5) {
      causes.push(`  cause: ${c?.name ?? 'unknown'}: ${c?.message ?? String(c)}`);
      c = (c as any)?.cause;
    }
    logError(
      `unhandledRejection: name=${r?.name ?? 'unknown'} message=${r?.message ?? String(reason)}\n` +
      `stack: ${r?.stack ?? '(none)'}\n` +
      (causes.length ? causes.join('\n') : '')
    );
  });

  // Theme loads synchronously before the first render so there is no
  // default-palette flash (a bad file falls back to the default theme).
  if (opts.config.logLevel) setLogLevel(opts.config.logLevel);
  const theme = loadTheme();
  setTheme(theme);
  setKeybindings(loadKeybindings());

  // Raw-mode Ctrl+C arrives as a key event handled inside <App> (double-press
  // to exit); exitSignals is empty so the renderer never races us on SIGINT.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    // Ink-like UX: render on the main screen and keep the final frame in the
    // terminal scrollback on exit (instead of the alternate screen).
    screenMode: 'main-screen',
    clearOnShutdown: false,
  });

  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let shutDown = false;
  const shutdown = () => {
    if (shutDown) return;
    shutDown = true;
    try {
      root.unmount(); // stop React effects first
    } finally {
      renderer.destroy(); // idempotent; restores terminal state
      resolveExit();
    }
  };
  // Any path that destroys the renderer without going through shutdown()
  // still unblocks the caller.
  renderer.on('destroy', () => {
    shutDown = true;
    resolveExit();
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const root = createRoot(renderer);
  root.render(
    <AppExitProvider value={shutdown}>
      <App
        agent={opts.agent}
        sessionManager={opts.sessionManager}
        config={opts.config}
        sessionId={opts.sessionId}
        session={opts.session}
        initialMode={opts.mode}
        theme={theme}
      />
    </AppExitProvider>,
  );

  await exited;
}
