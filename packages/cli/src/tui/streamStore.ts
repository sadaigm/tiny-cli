// ─────────────────────────────────────────────────────────────────
// StreamStore — external store for live streaming content.
//
// Token-by-token deltas (thinking / response text) and spinner-text
// changes live HERE, outside React's root state, so a delta re-renders
// only the small panel subscribed to it — never the whole <App>. When a
// stream finishes, the accumulated text is committed to the root log via
// a one-shot callback (addLog), so committed entries stay immutable.
// ─────────────────────────────────────────────────────────────────

import { logDebug } from '@tiny-cli/core';

/** Live content of one streaming phase (thinking or response). */
export interface StreamSection {
  /** Accumulated text so far. */
  text: string;
  /** True while the section is still receiving deltas. */
  active: boolean;
}

const emptySection = (): StreamSection => ({ text: '', active: false });

/**
 * Minimal observable store. Three independently-notified sections:
 * `thinking`, `response`, `spinner` — a thinking delta does not wake the
 * response panel or the spinner, and vice-versa.
 */
export class StreamStore {
  private thinking = emptySection();
  private response = emptySection();
  private spinner = { active: false, text: '' };
  private thinkingSubs = new Set<() => void>();
  private responseSubs = new Set<() => void>();
  private spinnerSubs = new Set<() => void>();

  /**
   * Called once when a section finishes (commit*() / clear()) with the
   * full accumulated text, so the consumer can addLog() it. Assigned by
   * the App; typing accommodates the reasoning/assistant entry kinds.
   */
  onCommit: ((type: 'reasoning' | 'assistant', text: string) => void) | null = null;

  // ── subscriptions (useSyncExternalStore) ──
  subscribeThinking = (cb: () => void): (() => void) => {
    this.thinkingSubs.add(cb);
    return () => this.thinkingSubs.delete(cb);
  };
  subscribeResponse = (cb: () => void): (() => void) => {
    this.responseSubs.add(cb);
    return () => this.responseSubs.delete(cb);
  };
  subscribeSpinner = (cb: () => void): (() => void) => {
    this.spinnerSubs.add(cb);
    return () => this.spinnerSubs.delete(cb);
  };

  getThinking = (): StreamSection => this.thinking;
  getResponse = (): StreamSection => this.response;
  getSpinner = (): { active: boolean; text: string } => this.spinner;

  // ── writers (called from useAgent callbacks) ──
  appendThinking = (delta: string): void => {
    this.thinking = { text: this.thinking.text + delta, active: true };
    this.notify('thinking', this.thinkingSubs);
  };

  appendResponse = (delta: string): void => {
    this.response = { text: this.response.text + delta, active: true };
    this.notify('response', this.responseSubs);
  };

  setSpinner = (active: boolean, text: string): void => {
    if (this.spinner.active === active && this.spinner.text === text) return;
    this.spinner = { active, text };
    this.spinnerSubs.forEach((cb) => cb());
  };

  /**
   * Finish the thinking phase: hand the accumulated text to onCommit
   * (→ addLog as a collapsed reasoning entry) and reset the section.
   * Safe to call repeatedly — a no-op when already inactive.
   */
  commitThinking = (): void => {
    if (!this.thinking.active) return;
    const text = this.thinking.text;
    this.thinking = emptySection();
    this.thinkingSubs.forEach((cb) => cb());
    if (text) this.onCommit?.('reasoning', text);
  };

  /** Same as commitThinking for the response text (assistant entry). */
  commitResponse = (): void => {
    if (!this.response.active) return;
    const text = this.response.text;
    this.response = emptySection();
    this.responseSubs.forEach((cb) => cb());
    if (text) this.onCommit?.('assistant', text);
  };

  /** Reset everything (turn end / abort) without committing. */
  clear = (): void => {
    this.thinking = emptySection();
    this.response = emptySection();
    this.notify('clear:thinking', this.thinkingSubs);
    this.notify('clear:response', this.responseSubs);
  };

  /**
   * Trace wrapper around subscriber notification: if a subscriber
   * (useSyncExternalStore callback → React render) throws, the error lands
   * in the trace log with the section name instead of escaping raw.
   */
  private notify(section: string, subs: Set<() => void>): void {
    subs.forEach((cb) => {
      try {
        cb();
      } catch (err: unknown) {
        const e = err as Error;
        logDebug(`[trace] StreamStore ${section} subscriber threw: ${e?.name}: ${e?.message}\n${e?.stack ?? ''}`);
        throw err;
      }
    });
  }
}
