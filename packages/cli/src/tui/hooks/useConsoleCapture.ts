import { useEffect, useRef } from 'react';
import { logError, logTrace } from '@tiny-cli/core';
import type { LogEntryType } from '../state.js';

/**
 * A partial log entry produced by intercepting console output.
 *
 * The parent component ({@link App}) receives this and fills in the
 * `id` and `timestamp` before adding it to the log array.
 */
export interface CapturedEntry {
  /** Log category — always `'info'` for stdout methods, `'error'` for stderr. */
  type: LogEntryType;
  /** The formatted string output. */
  content: string;
}

/**
 * Format `console.*()` arguments into a single string.
 *
 * Strings are passed through as-is; `Error` instances yield their
 * `message` (plus `stack` if present); other objects are serialised
 * via `JSON.stringify` with a `String()` fallback for circular
 * references.
 *
 * @param args - The spread arguments from a `console.*()` call.
 * @returns A single space-joined string.
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) {
        return arg.stack ?? arg.message;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        // Circular reference or other serialisation failure
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Intercept `console.log`, `console.info`, `console.error`, and
 * `console.warn` so that output is routed into the TUI message log
 * instead of writing directly to stdout/stderr.
 *
 * **Why this is needed:** The `Agent` class in `@tiny-cli/core` calls
 * `console.log` and `console.error` in several places (e.g. context
 * compaction, tool execution diagnostics).  When Ink is managing the
 * terminal, any raw `process.stdout.write` will corrupt the rendered
 * layout.  By overriding the console methods, all such output is
 * captured and displayed neatly as `info` or `error` log entries.
 *
 * **Lifecycle:** The console overrides are installed once on mount and
 * restored on unmount.  The latest `addLog` callback is held in a ref
 * so that the effect never re-runs (and thus never leaves the console
 * in an overridden state between renders), while still calling the
 * up-to-date function.
 *
 * @param addLog - Callback invoked for each captured console output.
 *                 Receives a {@link CapturedEntry} with `type` and
 *                 `content`.
 *
 * @example
 * ```tsx
 * const addLog = useCallback((entry: CapturedEntry) => {
 *   dispatch({ type: 'ADD_LOG', entry });
 * }, []);
 *
 * useConsoleCapture(addLog);
 * ```
 */
export function useConsoleCapture(
  addLog: (entry: CapturedEntry) => void,
): void {
  // Hold the latest callback in a ref so the effect closure stays fresh
  // without forcing the effect to re-run on every render.
  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;

  useEffect(() => {
    // --- Save originals ---
    const origLog = console.log;
    const origInfo = console.info;
    const origError = console.error;
    const origWarn = console.warn;

    // --- Override stdout methods → 'info' entries ---
    console.log = (...args: unknown[]): void => {
      const content = formatArgs(args);
      if (content.trim()) {
        addLogRef.current({ type: 'info', content });
      }
    };

    console.info = (...args: unknown[]): void => {
      const content = formatArgs(args);
      if (content.trim()) {
        addLogRef.current({ type: 'info', content });
      }
    };

    // --- Override stderr methods → 'error' entries ---
    console.error = (...args: unknown[]): void => {
      const content = formatArgs(args);
      if (!content.trim()) return;
      const err = args.find((a): a is Error => a instanceof Error);
      // AbortError after a user abort (Esc) surfaces here via OpenTUI's key
      // dispatch — expected, not an error. Trace it and render nothing;
      // runTurn already logs "Turn aborted." as a system entry.
      if (err?.name === 'AbortError') {
        logTrace(`console.error (expected abort): ${err.message}`);
        return;
      }
      // Also write to the log file — the render.tsx console.error wrapper
      // was replaced by this override, so without this, stderr output
      // (e.g. OpenTUI key-handler errors) never reaches tui.log.
      logError(
        err
          ? `console.error: ${err.name}: ${err.message}\n${err.stack ?? '(no stack)'}`
          : `console.error: ${content}`,
      );
      addLogRef.current({ type: 'error', content });
    };

    console.warn = (...args: unknown[]): void => {
      const content = formatArgs(args);
      if (content.trim()) {
        addLogRef.current({ type: 'error', content });
      }
    };

    // --- Restore on unmount ---
    return () => {
      console.log = origLog;
      console.info = origInfo;
      console.error = origError;
      console.warn = origWarn;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
