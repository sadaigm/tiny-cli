/**
 * Ink-compatible shims over OpenTUI (migration: ink → @opentui/react).
 *
 * The TUI's components were written against Ink's API surface
 * (`<Box>`/`<Text>`, `useInput`, `usePaste`, `useStdout`, `useApp`). This
 * module re-exports those names backed by OpenTUI so the component ports
 * stay 1:1 — see docs/migration-opentui.md ("port 1:1 before any refactor").
 *
 * Semantics preserved:
 * - `useInput(handler, { isActive })`: ink-shaped `{ input, key }` events.
 *   Inactive handlers also `preventDefault()` so the focused editor never
 *   sees keys another layer owns (OpenTUI globals run before the focused
 *   renderable; ink's isActive had the same effect implicitly).
 * - `<Box>` defaults to `flexDirection: "row"` (ink/CSS default; OpenTUI
 *   boxes default to column).
 * - Ink/chalk colour names map onto OpenTUI's named-colour set.
 *
 * New code may use `key.name` (canonical OpenTUI name) and
 * `key.preventDefault()` exposed on the compat key object.
 */

import React, { createContext, useContext, useRef } from 'react';
import { useKeyboard, useTerminalDimensions, usePaste as useOpentuiPaste } from '@opentui/react';
import { decodePasteBytes, type KeyEvent } from '@opentui/core';
import { logError } from '@tiny-cli/core';

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** chalk/ink names that differ from OpenTUI's named-colour set. */
const COLOR_MAP: Record<string, string> = {
  white: 'silver', // chalk white is the light-grey #C5C8C6; OpenTUI white is #FFFFFF
  whiteBright: 'white',
  blackBright: 'brightBlack',
  redBright: 'brightRed',
  greenBright: 'brightGreen',
  yellowBright: 'brightYellow',
  blueBright: 'brightBlue',
  magentaBright: 'brightMagenta',
  cyanBright: 'brightCyan',
};

/** Map an ink/chalk colour spec (named or `#hex`) to an OpenTUI colour. */
export function inkColor(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return COLOR_MAP[color] ?? color;
}

// ---------------------------------------------------------------------------
// Keys — OpenTUI KeyEvent → ink `{ input, key }`
// ---------------------------------------------------------------------------

/** Ink's `key` object, plus OpenTUI extras (`name`, `home`, `end`, `preventDefault`). */
export interface InkKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  /** OpenTUI canonical key name ("return", "up", "a", "space", …). */
  name: string;
  /** Extras ink lacks but our editor uses. */
  home: boolean;
  end: boolean;
  space: boolean;
  /** Block the focused renderable (e.g. textarea) from receiving this key. */
  preventDefault: () => void;
}

/** Convert an OpenTUI key event into ink's `(input, key)` pair. */
export function toInkKey(ev: KeyEvent): { input: string; key: InkKey } {
  const n = ev.name;
  const key: InkKey = {
    upArrow: n === 'up',
    downArrow: n === 'down',
    leftArrow: n === 'left',
    rightArrow: n === 'right',
    pageUp: n === 'pageup',
    pageDown: n === 'pagedown',
    return: n === 'return' || n === 'enter',
    escape: n === 'escape',
    tab: n === 'tab',
    backspace: n === 'backspace' || n === 'delete',
    delete: n === 'delete',
    shift: Boolean(ev.shift),
    ctrl: Boolean(ev.ctrl),
    meta: Boolean(ev.meta),
    name: n,
    home: n === 'home',
    end: n === 'end',
    space: n === 'space',
    // OpenTUI KeyEvents don't reliably expose preventDefault — calling it
    // throws on some event shapes, so guard it: ink keys are always callable.
    preventDefault: () => ev.preventDefault?.(),
  };
  // ink's `input`: the printable character for plain keys, the base letter for
  // ctrl/meta combos (ink delivers e.g. 'p' for ctrl+p — components match on
  // exactly that), control bytes for common control keys, '' otherwise.
  let input = '';
  if (n === 'space') input = ' ';
  else if (key.return) input = '\r';
  else if (n === 'tab') input = '\t';
  else if (n === 'escape') input = '\x1b';
  else if (ev.ctrl || ev.meta) input = n.length === 1 ? n.toLowerCase() : '';
  else if (typeof ev.sequence === 'string' && ev.sequence.length === 1) input = ev.sequence;
  return { input, key };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Ink `useInput` shim over `useKeyboard` (see module doc). */
export function useInput(
  handler: (input: string, key: InkKey) => void,
  options?: { isActive?: boolean },
): void {
  const active = options?.isActive !== false;
  const ref = useRef(handler);
  ref.current = handler;
  useKeyboard((ev: KeyEvent) => {
    if (ev.eventType !== 'press' && ev.eventType !== 'repeat') return;
    if (!active) return; // ink semantics: inactive handlers simply don't fire
    const { input, key } = toInkKey(ev);
    try {
      ref.current(input, key);
    } catch (err) {
      // A throwing key handler must not escape into OpenTUI's stdin dispatch
      // (it kills every subsequent keypress). Log and keep the loop alive.
      logError(`useInput handler threw for input=${JSON.stringify(input)}: ${(err as Error)?.stack ?? String(err)}`);
    }
  });
}

/**
 * Ink `usePaste` shim: delivers decoded paste text (bracketed paste).
 * The second argument exposes `preventDefault()` — call it to keep the
 * focused `<textarea>`/`<input>` from also inserting the pasted text
 * (global paste listeners run before the focused renderable).
 */
export function usePaste(
  handler: (text: string, evt: { preventDefault: () => void }) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useOpentuiPaste((event) => {
    ref.current(decodePasteBytes(event.bytes), { preventDefault: () => event.preventDefault() });
  });
}

/** Minimal ink `useStdout` shim over `useTerminalDimensions`. */
export function useStdout(): {
  stdout: { columns: number; rows: number; write: (s: string) => boolean };
} {
  const { width, height } = useTerminalDimensions();
  return {
    stdout: {
      columns: width,
      rows: height,
      write: (s: string) => process.stdout.write(s),
    },
  };
}

// ---------------------------------------------------------------------------
// useApp().exit() — provided by render.tsx (single renderer owner)
// ---------------------------------------------------------------------------

type ExitFn = () => void;
const AppExitContext = createContext<ExitFn>(() => {});

/** Provide the real shutdown callback from the render owner. */
export const AppExitProvider: React.Provider<ExitFn> = AppExitContext.Provider;

/** Ink `useApp` shim — `exit()` triggers the app-wide shutdown path. */
export function useApp(): { exit: ExitFn } {
  const exit = useContext(AppExitContext);
  return { exit };
}

// ---------------------------------------------------------------------------
// <Box> / <Text>
// ---------------------------------------------------------------------------

/** Ink border styles → OpenTUI borderStyle values. */
const BORDER_MAP: Record<string, string> = {
  round: 'rounded',
  bold: 'heavy',
};

/** Layout props passed straight through to the OpenTUI `<box>` style. */
const BOX_LAYOUT_KEYS = [
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'flexGrow', 'flexShrink', 'flexBasis', 'flexWrap',
  'justifyContent', 'alignItems', 'alignSelf',
  'gap', 'rowGap', 'columnGap',
  'overflow', 'position', 'top', 'right', 'bottom', 'left',
  'zIndex',
] as const;

export interface BoxProps {
  children?: React.ReactNode;
  /**
   * OpenTUI's JSX types don't model React's `key` on function components
   * (their reconciler handles it fine) — declared here so keyed lists of
   * `<Box>`/`<Text>` typecheck.
   */
  key?: React.Key;
  flexDirection?: string;
  width?: number | string;
  height?: number | string;
  borderStyle?: string;
  borderColor?: string;
  backgroundColor?: string;
  /** see BOX_LAYOUT_KEYS for the rest */
  [prop: string]: unknown;
}

/** Ink `<Box>` shim over OpenTUI `<box>` (row layout default, like ink). */
export function Box({ children, borderStyle, borderColor, backgroundColor, ...rest }: BoxProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const style: any = { flexDirection: rest.flexDirection ?? 'row' };
  for (const k of BOX_LAYOUT_KEYS) {
    if (rest[k] !== undefined) style[k] = rest[k];
  }
  // ink clips per-axis; OpenTUI has one `overflow` — hidden on either axis
  // becomes hidden clipping.
  if (rest.overflowY === 'hidden' || rest.overflowX === 'hidden') style.overflow = 'hidden';
  if (borderStyle !== undefined) {
    style.border = true;
    style.borderStyle = BORDER_MAP[borderStyle] ?? borderStyle;
  }
  if (borderColor !== undefined) style.borderColor = inkColor(borderColor as string);
  if (backgroundColor !== undefined) style.backgroundColor = inkColor(backgroundColor as string);
  // Mouse handlers (e.g. onMouseScroll for wheel) are renderable options,
  // not styles — forward them to the `<box>` element directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mouseHandlers: any = {};
  for (const k of Object.keys(rest)) {
    if (k.startsWith('onMouse') && typeof rest[k] === 'function') mouseHandlers[k] = rest[k];
  }
  return (
    <box style={style} {...mouseHandlers}>
      {children}
    </box>
  );
}

export interface TextProps {
  children?: React.ReactNode;
  /** See BoxProps.key — declared for keyed lists. */
  key?: React.Key;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  /** ink wrap values; truncating variants degrade to no-wrap (clipped). */
  wrap?: 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';
}

/**
 * True while rendering inside a `<text>` — OpenTUI text nodes only accept
 * strings and inline elements, so a nested ink `<Text>` must become a
 * `<span>` (ink allows Text-in-Text; OpenTUI does not).
 */
const InTextContext = createContext(false);

/** Ink `<Text>` shim over OpenTUI `<text>` + inline elements. */
export function Text({
  children,
  color,
  backgroundColor,
  bold,
  dimColor,
  italic,
  underline,
  inverse,
  wrap,
}: TextProps) {
  let fg = inkColor(color ?? (dimColor ? 'gray' : undefined));
  let bg = inkColor(backgroundColor);
  if (inverse) {
    const swap = fg;
    fg = bg ?? 'black';
    bg = swap ?? 'silver';
  }
  let content = children;
  if (bold) content = <b>{content}</b>;
  if (italic) content = <i>{content}</i>;
  if (underline) content = <u>{content}</u>;

  // Nested ink <Text>-in-<Text> renders as an inline <span>.
  if (useContext(InTextContext)) {
    return (
      <span fg={fg} bg={bg}>
        {content}
      </span>
    );
  }
  return (
    <text fg={fg} bg={bg} wrapMode={wrap && wrap !== 'wrap' ? 'none' : undefined}>
      <InTextContext.Provider value={true}>{content}</InTextContext.Provider>
    </text>
  );
}
