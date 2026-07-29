import path from "path";

/**
 * Async reader/writer lock used to coordinate mutating tool calls in a batch.
 *
 *  - File-mutating calls (write/search_replace/insert_lines/plan_write/the
 *    shared task file) acquire **shared** access: they may run concurrently
 *    with other file mutations, EXCEPT they additionally take a per-path
 *    mutex (see MutexMap) so two calls hitting the same file serialize.
 *  - Global mutating calls (bash, and mcp__ tools which lack isModifying
 *    metadata) acquire **exclusive** access: no other mutation runs while
 *    they do, because bash/mcp can touch any file.
 *  - Read-only tools (read/list/grep/glob) bypass this lock entirely.
 *
 * Net effect: different-file writes run in parallel; same-file writes
 * serialize; reads run in parallel with everything; bash/mcp never overlap
 * another mutation. Shared acquires yield to a queued exclusive to avoid
 * starving bash/mcp. No external dependency.
 */
export class MutationGate {
  private activeShared = 0;
  private exclusiveRunning = false;
  private waitingExclusive = 0;
  private sharedWaiters: Array<() => void> = [];
  private exclusiveWaiters: Array<() => void> = [];

  private poke() {
    // Prefer admitting an exclusive waiter when nothing is running, to avoid
    // starving bash/mcp. Otherwise admit all eligible shared waiters.
    if (!this.exclusiveRunning && this.activeShared === 0 && this.exclusiveWaiters.length) {
      const w = this.exclusiveWaiters.shift()!;
      this.exclusiveRunning = true;
      w();
      return;
    }
    if (!this.exclusiveRunning && this.waitingExclusive === 0) {
      while (this.sharedWaiters.length) {
        const w = this.sharedWaiters.shift()!;
        this.activeShared++;
        w();
      }
    }
  }

  async acquireShared(): Promise<() => void> {
    // Block while an exclusive call is running or queued (yield to bash/mcp).
    if (this.exclusiveRunning || this.waitingExclusive > 0) {
      await new Promise<void>((resolve) => this.sharedWaiters.push(resolve));
    } else {
      this.activeShared++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeShared--;
      if (this.activeShared === 0) this.poke();
    };
  }

  async acquireExclusive(): Promise<() => void> {
    this.waitingExclusive++;
    if (this.exclusiveRunning || this.activeShared > 0) {
      await new Promise<void>((resolve) => this.exclusiveWaiters.push(resolve));
      this.waitingExclusive--;
    } else {
      this.waitingExclusive--;
      this.exclusiveRunning = true;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exclusiveRunning = false;
      this.poke();
    };
  }
}

/** Minimal per-key async mutex (promise chain). Serializes file-mutating
 *  calls that target the SAME resolved path. */
export class MutexMap {
  private tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    // Chain on the previous holder's tail. Each acquirer captures its OWN
    // release resolver, so concurrent queuers don't clobber each other.
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const myTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, myTail);
    await prev;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  }
}

/** Sentinel lock key for bash: it has unbounded reach, so it must never run
 *  concurrently with any mutating tool. */
export const BASH_LOCK = "__bash__";
/** Sentinel lock key for all MCP tools: they lack isModifying metadata, so we
 *  serialize them against every mutating built-in tool but let them run
 *  parallel to read-only tools. */
export const MCP_LOCK = "__mcp__";

/** Monotonic counter for unique fallback lock keys (malformed args). */
let badArgsCounter = 0;

/** Resolve a per-call lock key so independent calls run in parallel while
 *  calls touching the same resource serialize. Returns null for read-only
 *  tools (fully parallel). Malformed args fall back to a unique serializing
 *  key so classify never throws before the executor's try/catch. */
export function classifyLockKey(
  name: string,
  parsedArgs: any,
  context: { sessionId?: string; cwd: string }
): string | null {
  const cwd = context.cwd;
  try {
    if (name === "bash") return BASH_LOCK;
    if (name.startsWith("mcp__")) return MCP_LOCK;
    if (name === "search_replace" || name === "insert_lines" || name === "write") {
      const p = parsedArgs?.path;
      if (typeof p === "string" && p.length > 0) return path.resolve(cwd, p);
      return `__badargs:${name}:${badArgsCounter++}__`;
    }
    if (name === "manage_tasks" || name === "mark_task_complete") {
      // Both read-modify-write the same fixed session file.
      const sid = context.sessionId ?? "__nosession__";
      return path.join(cwd, ".tiny-cli", sid, "plan", "current_task.md");
    }
    if (name === "plan_write") {
      const sid = context.sessionId ?? "__nosession__";
      const p = parsedArgs?.path;
      const planDir = path.join(cwd, ".tiny-cli", sid, "plan");
      if (typeof p === "string" && p.length > 0) return path.resolve(planDir, p);
      return `__badargs:${name}:${badArgsCounter++}__`;
    }
    // read, list, grep, glob (and any other built-in) are read-only.
    return null;
  } catch {
    return `__badargs:${name}:${badArgsCounter++}__`;
  }
}
