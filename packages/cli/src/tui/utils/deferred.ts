/**
 * Deferred promise utility.
 *
 * A deferred wraps a Promise, exposing its `resolve` and `reject` methods
 * externally so that the promise can be settled from outside the original
 * executor callback. This is the backbone of the approval-modal flow:
 *
 *   1. The agent calls `onApproval(call)` which internally creates a deferred.
 *   2. The agent awaits `deferred.promise`, suspending its async loop.
 *   3. The TUI renders an ApprovalModal and, when the user selects an option,
 *      calls `deferred.resolve(choice)`.
 *   4. The agent wakes up and continues (or aborts).
 *
 * The key property: the agent's `await` does NOT block the React/Ink render
 * loop — Ink's event loop runs independently.
 */

export interface Deferred<T> {
  /** The promise that callers will `await`. */
  promise: Promise<T>;
  /** Resolve the promise with a value. */
  resolve: (value: T) => void;
  /** Reject the promise with an error. */
  reject: (reason?: unknown) => void;
  /** Whether the promise has been resolved or rejected. */
  settled: boolean;
}

/**
 * Create a deferred promise.
 *
 * @returns A {@link Deferred} object with `promise`, `resolve`, `reject`, and `settled`.
 *
 * @example
 * ```ts
 * const deferred = createDeferred<string>();
 *
 * // Somewhere else in the code:
 * setTimeout(() => deferred.resolve('done'), 1000);
 *
 * // Await the result:
 * const result = await deferred.promise; // 'done'
 * ```
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => {
      if (!settled) {
        settled = true;
        res(value);
      }
    };
    reject = (reason?: unknown) => {
      if (!settled) {
        settled = true;
        rej(reason);
      }
    };
  });

  return { promise, resolve, reject, settled };
}
