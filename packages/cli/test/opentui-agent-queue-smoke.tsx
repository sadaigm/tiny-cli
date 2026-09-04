/**
 * Headless queue-drain smoke test for `useAgent` (migration phase 7 port of
 * `useAgent-queue.test.tsx`). Run directly with bun — no terminal needed:
 *
 *   cd packages/cli && bun test/opentui-agent-queue-smoke.tsx
 *
 * Exercises the real hook with a controllable stub Agent whose `run()` only
 * resolves when released, then asserts submission-order queue drain:
 *
 *   1. start a turn (agent becomes "busy"),
 *   2. submit more messages mid-turn (must be QUEUED, not dropped or run),
 *   3. release turns one by one (queue must auto-drain in FIFO order).
 */
import React, { useEffect, useRef } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { useAgent } from '../src/tui/hooks/useAgent.js';
import { StreamStore } from '../src/tui/streamStore.js';
import type { AgentStep, AgentResponse, ToolCall } from '@tiny-cli/core';

let failures = 0;

// ─── Stub Agent ────────────────────────────────────────────────────────

interface RunHandle {
  input: string;
  resolve: (r: AgentResponse) => void;
  reject: (e: Error) => void;
}

function createStubAgent() {
  const calls: string[] = [];
  const pending: RunHandle[] = [];

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

  function releaseNext(content = ''): RunHandle | undefined {
    const handle = pending.shift();
    handle?.resolve({ content, steps: [] });
    return handle;
  }

  return { agent, calls, releaseNext };
}

// ─── Harness ───────────────────────────────────────────────────────────

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
    sessionManager: { saveSession: async () => {}, loadSession: async () => null } as any,
    sessionId: 'smoke-session',
    setState: (patch) => {
      patches.current.push(patch as Record<string, unknown>);
    },
    addLog: () => {},
    getMode: () => 'agent' as const,
    streamStore: new StreamStore(),
  });

  ref.current.api = api;
  ref.current.patches = patches.current;

  useEffect(() => {
    (globalThis as any).__harnessRef = ref.current;
    force();
  }, []);

  return null;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

async function mount(agent: any): Promise<HarnessHandle> {
  const setup = await testRender(<Harness agent={agent} />, { width: 80, height: 24 });
  await setup.flush();
  (globalThis as any).__destroy = () => setup.renderer.destroy();
  return (globalThis as any).__harnessRef as HarnessHandle;
}

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

function assert(name: string, cond: boolean, actual: unknown, expected: unknown): void {
  check(name, cond, cond ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function withMounted(agent: any, fn: (h: HarnessHandle) => Promise<void>): Promise<void> {
  delete (globalThis as any).__harnessRef;
  const h = await mount(agent);
  try {
    await fn(h);
  } finally {
    (globalThis as any).__destroy();
    delete (globalThis as any).__harnessRef;
  }
}

// ─── Scenarios ─────────────────────────────────────────────────────────

await withMounted(createStubAgent().agent, async (h) => {
  // Warm mount only — real scenarios below create their own stubs.
  check('useAgent mounts', h.api !== null);
});

{
  const { agent, calls } = createStubAgent();
  await withMounted(agent, async (h) => {
    h.api!.submitMessage('hello');
    await flush();
    assert('immediate run when idle', calls.join(',') === 'hello', calls, ['hello']);
  });
}

{
  const { agent, calls, releaseNext } = createStubAgent();
  await withMounted(agent, async (h) => {
    h.api!.submitMessage('first');
    await flush();
    h.api!.submitMessage('second');
    h.api!.submitMessage('third');
    await flush();
    assert('mid-turn submits are queued', calls.join(',') === 'first', calls, ['first']);
    check(
      'queue patch recorded',
      h.patches.some((p) => (p as any).messageQueue?.length === 2),
    );

    releaseNext();
    await flush();
    assert('drain runs second', calls.join(',') === 'first,second', calls, ['first', 'second']);

    releaseNext();
    await flush();
    assert('drain runs third', calls.join(',') === 'first,second,third', calls, ['first', 'second', 'third']);
  });
}

{
  const { agent, calls, releaseNext } = createStubAgent();
  await withMounted(agent, async (h) => {
    h.api!.submitMessage('A');
    await flush();
    h.api!.submitMessage('B'); // queued
    releaseNext(); // finish A → B starts
    await flush();
    h.api!.submitMessage('C'); // queued behind B
    releaseNext(); // finish B → C starts
    await flush();
    releaseNext(); // finish C
    await flush();
    assert('FIFO order under interleaving', calls.join(',') === 'A,B,C', calls, ['A', 'B', 'C']);
  });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
