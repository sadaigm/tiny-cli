/**
 * @vitest-environment node
 *
 * Integration test for the "type while the agent is working" requirement.
 *
 * Strategy: we exercise the real `useAgent` hook (the source of the
 * queue/drain logic) inside a tiny Ink-rendered harness, backed by a
 * controllable stub `Agent`. The stub's `run()` returns a promise that
 * only resolves when we explicitly release it, so we can:
 *
 *   1. start a turn (agent becomes "busy"),
 *   2. submit another message mid-turn (must be QUEUED, not dropped or run),
 *   3. release the first turn (must auto-drain the queue and run it),
 *   4. assert the order of `run()` calls matches submission order.
 *
 * This is the actual user-facing behaviour the TUI rewrite exists to fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useEffect, useRef } from 'react';
import { render } from 'ink-testing-library';
import { useAgent } from '../src/tui/hooks/useAgent.js';
import type { AgentStep, AgentResponse, ToolCall } from '@tiny-cli/core';

// ─── Stub Agent ────────────────────────────────────────────────────────
// Only the surface area that useAgent touches. `run()` is the lever: each
// invocation records its input and returns a promise we control.

interface RunHandle {
  input: string;
  resolve: (r: AgentResponse) => void;
  reject: (e: Error) => void;
}

function createStubAgent() {
  const calls: string[] = []; // ordered list of inputs handed to run()
  const pending: RunHandle[] = []; // unresolved run() invocations, FIFO

  const agent = {
    getHistory: () => [],
    getContextStats: () => ({ tokens: 0, characters: 0 }),
    getConfig: () => ({ model: 'stub', permissionMode: 'auto' }),
    updateConfig: () => {},
    setSessionId: () => {},
    setHistory: () => {},
    getToolDefinitions: () => [],
    destroy: () => Promise.resolve(),
    run: (
      userInput: string,
      _onStep?: (step: AgentStep) => void,
      _mode?: string,
      _continueSession?: boolean,
      _signal?: AbortSignal,
      _onApproval?: (call: ToolCall) => Promise<boolean>,
    ): Promise<AgentResponse> => {
      calls.push(userInput);
      return new Promise<AgentResponse>((resolve, reject) => {
        pending.push({ input: userInput, resolve, reject });
      });
    },
  };

  /** Resolve the oldest pending run() with an empty assistant response. */
  function releaseNext(content = ''): RunHandle | undefined {
    const handle = pending.shift();
    handle?.resolve({ content, steps: [] });
    return handle;
  }

  /** Resolve ALL currently-pending runs (drain the in-flight ones). */
  function releaseAll(): void {
    while (pending.length) releaseNext();
  }

  return { agent, calls, releaseNext, releaseAll, pending };
}

// ─── Stub SessionManager ───────────────────────────────────────────────

function createStubSessionManager() {
  return {
    saveSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
  };
}

// ─── Harness component ─────────────────────────────────────────────────
// Exposes the useAgent API via a ref so the test can drive submitMessage,
// and records state patches so we can assert on agentState / messageQueue.

interface HarnessHandle {
  api: ReturnType<typeof useAgent> | null;
  patches: Array<Record<string, unknown>>;
}

function Harness({ agent }: { agent: any }) {
  const ref = useRef<HarnessHandle>({ api: null, patches: [] });
  const [, force] = React.useReducer((x) => x + 1, 0);

  const patches = useRef<Record<string, unknown>[]>([]);

  const api = useAgent({
    agent,
    sessionManager: createStubSessionManager() as any,
    sessionId: 'test-session',
    setState: (patch) => {
      patches.current.push(patch as Record<string, unknown>);
    },
    addLog: () => {},
    getMode: () => 'agent' as const,
  });

  // Keep the latest api/patches reachable from outside render via ref.
  ref.current.api = api;
  ref.current.patches = patches.current;

  useEffect(() => {
    (globalThis as any).__harnessRef = ref.current;
    force(); // ensure ref is set after first paint
  }, []);

  return null;
}

async function flush() {
  // Let pending microtasks (fire-and-forget runAgentTurn, queue drain) settle.
  await new Promise((r) => setTimeout(r, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('useAgent — concurrent input (the core requirement)', () => {
  beforeEach(() => {
    delete (globalThis as any).__harnessRef;
  });

  it('runs an immediate message when idle', async () => {
    const { agent, calls } = createStubAgent();
    render(<Harness agent={agent} />);
    await flush();

    const handle = (globalThis as any).__harnessRef as HarnessHandle;
    handle.api!.submitMessage('hello');

    await flush();
    expect(calls).toEqual(['hello']);
  });

  it('QUEUES a message submitted while the agent is busy, then drains it in order', async () => {
    const { agent, calls, releaseNext, releaseAll } = createStubAgent();
    render(<Harness agent={agent} />);
    await flush();

    const handle = (globalThis as any).__harnessRef as HarnessHandle;

    // 1. Start a turn — agent becomes busy (run() won't resolve until released).
    handle.api!.submitMessage('first');
    await flush();
    expect(calls).toEqual(['first']); // first turn started

    // 2. While busy, submit two more. They must NOT trigger run() yet.
    handle.api!.submitMessage('second');
    handle.api!.submitMessage('third');
    await flush();
    expect(calls).toEqual(['first']); // still only the first — the rest are queued
    expect(handle.patches.some((p) => (p as any).messageQueue?.length === 2)).toBe(true);

    // 3. Release the first turn → queue should auto-drain: second runs immediately.
    releaseNext();
    await flush();
    expect(calls).toEqual(['first', 'second']);

    // 4. Release the second → third runs.
    releaseNext();
    await flush();
    expect(calls).toEqual(['first', 'second', 'third']);

    // 5. Release the last → nothing left; queue empties.
    releaseAll();
    await flush();
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('preserves FIFO submission order under interleaving', async () => {
    const { agent, calls, releaseNext } = createStubAgent();
    render(<Harness agent={agent} />);
    await flush();

    const handle = (globalThis as any).__harnessRef as HarnessHandle;

    handle.api!.submitMessage('A');
    await flush();
    handle.api!.submitMessage('B'); // queued
    releaseNext(); // finish A → B starts
    await flush();
    handle.api!.submitMessage('C'); // queued behind B
    releaseNext(); // finish B → C starts
    await flush();
    releaseNext(); // finish C
    await flush();

    expect(calls).toEqual(['A', 'B', 'C']);
  });
});
