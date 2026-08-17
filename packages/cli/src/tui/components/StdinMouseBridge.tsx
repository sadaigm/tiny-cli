import React, { useEffect } from 'react';
import { useStdout } from 'ink';

/**
 * Props for {@link StdinMouseBridge}.
 */
export interface StdinMouseBridgeProps {
  /** Called with `+1` for wheel-down (scroll toward newer) and `-1` for wheel-up. */
  onWheel: (delta: number) => void;
  /** When false, the bridge mounts nothing and no mouse tracking is enabled. */
  enabled: boolean;
}

/**
 * Enables terminal mouse-tracking and translates wheel events into scroll
 * deltas for the conversation pane.
 *
 * Ink v5's `useInput` does not surface mouse events, so we enable SGR mouse
 * mode (`?1006` = extended coordinate format, `?1003` = any-event tracking)
 * directly on stdout and parse the resulting `\x1B[<button;col;row;M` reports
 * from raw stdin. Wheel-up is button `64`, wheel-down is button `65`.
 *
 * On unmount the terminal modes are restored so text selection / copy works
 * again outside the app. If the stream is not a TTY (e.g. piped output, CI),
 * the bridge renders nothing and the keyboard remains the fallback.
 *
 * @example
 * ```tsx
 * <StdinMouseBridge enabled={state.mouseEnabled} onWheel={(d) => paneRef.current?.wheel(d)} />
 * ```
 */
export default function StdinMouseBridge({ onWheel, enabled }: StdinMouseBridgeProps): React.ReactElement | null {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!enabled) return;
    const stdin = process.stdin;
    if (!stdin || !stdin.isTTY || !stdout || !stdout.isTTY) return;

    // Button-event mode (?1002): reports clicks and wheel but NOT every
    // cursor move (which all-events ?1003 would flood). ?1006 = SGR format.
    const ENABLE = '\x1B[?1006h\x1B[?1002h';
    const DISABLE = '\x1B[?1002l\x1B[?1006l';

    stdout.write(ENABLE);

    // SGR mouse report buffer (escape sequences can arrive split across chunks).
    let buffer = '';
    // Matches \x1B[<button;col;row;M or m
    const sgrMouse = /\x1B\[<(\d+);(\d+);(\d+)([Mm])/g;

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Process every complete report currently in the buffer.
      let match: RegExpExecArray | null;
      sgrMouse.lastIndex = 0;
      const consumed = [];
      while ((match = sgrMouse.exec(buffer)) !== null) {
        const button = Number(match[1]);
        const terminator = match[4];
        // Only the press ('M') of a wheel button matters; 'm' is the release.
        if (terminator === 'M') {
          if (button === 64) onWheel(-1); // wheel up
          else if (button === 65) onWheel(1); // wheel down
        }
        consumed.push(match.index + match[0].length);
      }
      if (consumed.length > 0) {
        buffer = buffer.slice(consumed[consumed.length - 1]);
      }
      // Bound the buffer so unparseable junk can't grow forever.
      if (buffer.length > 256) buffer = '';
    };

    // Read mouse reports straight off the raw stdin stream. Ink consumes its
    // own copy for key handling; this listener does not consume bytes — it only
    // watches for SGR mouse sequences while mouse mode is enabled.
    stdin.on('data', onData);

    return () => {
      stdin.removeListener('data', onData);
      stdout.write(DISABLE);
    };
  }, [enabled, stdout, onWheel]);

  return null;
}
