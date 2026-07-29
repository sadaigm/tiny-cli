import { MutationGate, MutexMap, classifyLockKey, toolLabel, computeMaxConcurrency } from '../concurrency';

const ctx = { sessionId: 'sess', cwd: '/repo' };

describe('classifyLockKey', () => {
  it('routes read-only tools to null (fully parallel)', () => {
    expect(classifyLockKey('read', { path: 'a.ts' }, ctx)).toBeNull();
    expect(classifyLockKey('grep', { pattern: 'x' }, ctx)).toBeNull();
    expect(classifyLockKey('list', {}, ctx)).toBeNull();
    expect(classifyLockKey('glob', {}, ctx)).toBeNull();
  });

  it('routes bash and mcp to their global mutating sentinels', () => {
    expect(classifyLockKey('bash', { cmd: 'ls' }, ctx)).toBe('__bash__');
    expect(classifyLockKey('mcp__srv__tool', {}, ctx)).toBe('__mcp__');
  });

  it('resolves file-mutating tools to the resolved path', () => {
    expect(classifyLockKey('write', { path: 'src/a.ts' }, ctx)).toBe('/repo/src/a.ts');
    expect(classifyLockKey('search_replace', { path: 'b.ts' }, ctx)).toBe('/repo/b.ts');
    expect(classifyLockKey('insert_lines', { path: 'c.ts' }, ctx)).toBe('/repo/c.ts');
  });

  it('gives manage_tasks and mark_task_complete the SAME key (shared task file)', () => {
    const a = classifyLockKey('manage_tasks', { action: 'mark_done' }, ctx);
    const b = classifyLockKey('mark_task_complete', {}, ctx);
    expect(a).toBe(b);
    expect(a).toBe('/repo/.tiny-cli/sess/plan/current_task.md');
  });

  it('falls back to a unique serializing key on malformed args (never throws)', () => {
    const k = classifyLockKey('write', {}, ctx);
    expect(typeof k).toBe('string');
    expect(k).toContain('__badargs');
    // Two malformed calls get distinct keys (so they don't serialize each other spuriously).
    const k2 = classifyLockKey('write', {}, ctx);
    expect(k).not.toBe(k2);
  });
});

describe('MutexMap (per-path serialization)', () => {
  it('serializes same-key acquisitions', async () => {
    const m = new MutexMap();
    const order: string[] = [];
    const task = (id: string, ms: number) => async () => {
      const rel = await m.acquire('same');
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end-${id}`);
      rel();
    };
    await Promise.all([task('a', 10)(), task('b', 10)(), task('c', 10)()]);
    // No two "start" should interleave with another's "end".
    expect(order).toEqual([
      'start-a', 'end-a',
      'start-b', 'end-b',
      'start-c', 'end-c',
    ]);
  });

  it('runs different keys in parallel', async () => {
    const m = new MutexMap();
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = (key: string) => async () => {
      const rel = await m.acquire(key);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      rel();
    };
    await Promise.all([
      task('/a')(),
      task('/b')(),
      task('/c')(),
    ]);
    expect(maxConcurrent).toBe(3);
  });
});

describe('MutationGate (reader/writer over mutations)', () => {
  it('runs multiple shared acquisitions concurrently', async () => {
    const g = new MutationGate();
    let concurrent = 0;
    let maxConcurrent = 0;
    const shared = async () => {
      const rel = await g.acquireShared();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      rel();
    };
    await Promise.all([shared(), shared(), shared()]);
    expect(maxConcurrent).toBe(3);
  });

  it('blocks shared while exclusive is held', async () => {
    const g = new MutationGate();
    const log: string[] = [];
    const exclusive = async () => {
      const rel = await g.acquireExclusive();
      log.push('ex-start');
      await new Promise((r) => setTimeout(r, 30));
      log.push('ex-end');
      rel();
    };
    const shared = async () => {
      const rel = await g.acquireShared();
      log.push('sh-start');
      await new Promise((r) => setTimeout(r, 10));
      log.push('sh-end');
      rel();
    };
    // Exclusive starts first; shared must wait until it releases.
    const exP = exclusive();
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([shared(), shared()]);
    await exP;
    const exEnd = log.indexOf('ex-end');
    const firstShStart = log.indexOf('sh-start');
    expect(exEnd).toBeGreaterThanOrEqual(0);
    expect(firstShStart).toBeGreaterThan(exEnd);
  });

  it('blocks exclusive while shared are running', async () => {
    const g = new MutationGate();
    const log: string[] = [];
    const shared = async () => {
      const rel = await g.acquireShared();
      log.push('sh-start');
      await new Promise((r) => setTimeout(r, 30));
      log.push('sh-end');
      rel();
    };
    const exclusive = async () => {
      const rel = await g.acquireExclusive();
      log.push('ex-start');
      rel();
    };
    const shP = shared();
    await new Promise((r) => setTimeout(r, 5));
    await exclusive();
    await shP;
    const shEnd = log.indexOf('sh-end');
    const exStart = log.indexOf('ex-start');
    expect(shEnd).toBeGreaterThanOrEqual(0);
    expect(exStart).toBeGreaterThan(shEnd);
  });

  it('does not deadlock under a mixed burst (no starvation, all complete)', async () => {
    const g = new MutationGate();
    const done: string[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push((async () => {
        const rel = await g.acquireShared();
        await new Promise((r) => setTimeout(r, 5));
        done.push(`s${i}`);
        rel();
      })());
    }
    for (let i = 0; i < 3; i++) {
      tasks.push((async () => {
        const rel = await g.acquireExclusive();
        await new Promise((r) => setTimeout(r, 5));
        done.push(`e${i}`);
        rel();
      })());
    }
    await Promise.all(tasks);
    expect(done.length).toBe(8); // none starved / dropped
  });
});

/**
 * Integration proxy for the agent's runExec locking pattern: a shared
 * MutationGate plus a per-path MutexMap. Proves that two concurrent writers
 * targeting the SAME path cannot interleave their critical sections.
 */
describe('runExec lock pattern (shared gate + per-path mutex)', () => {
  it('serializes two same-path writers so critical sections never overlap', async () => {
    const gate = new MutationGate();
    const pathMutex = new MutexMap();

    let activeWriters = 0;
    let maxOverlap = 0;
    const log: string[] = [];

    const writeSamePath = async (id: string) => {
      const relGate = await gate.acquireShared();
      let relPath!: () => void;
      try {
        relPath = await pathMutex.acquire('/repo/same.ts');
        // Critical section: record overlap.
        activeWriters++;
        maxOverlap = Math.max(maxOverlap, activeWriters);
        log.push(`enter-${id}`);
        await new Promise((r) => setTimeout(r, 15));
        log.push(`exit-${id}`);
        activeWriters--;
      } finally {
        relPath();
        relGate();
      }
    };

    await Promise.all([writeSamePath('a'), writeSamePath('b')]);
    expect(maxOverlap).toBe(1); // never two writers in the same path at once
    expect(log).toEqual(['enter-a', 'exit-a', 'enter-b', 'exit-b']);
  });

  it('runs two different-path writers concurrently', async () => {
    const gate = new MutationGate();
    const pathMutex = new MutexMap();

    let active = 0;
    let maxConcurrent = 0;
    const writePath = async (p: string) => {
      const relGate = await gate.acquireShared();
      let relPath!: () => void;
      try {
        relPath = await pathMutex.acquire(p);
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
      } finally {
        relPath();
        relGate();
      }
    };

    await Promise.all([writePath('/a.ts'), writePath('/b.ts')]);
    expect(maxConcurrent).toBe(2);
  });

  it('makes a global mutating (bash) writer exclusive against a file writer', async () => {
    const gate = new MutationGate();
    const pathMutex = new MutexMap();
    const log: string[] = [];

    const bashWriter = async () => {
      const rel = await gate.acquireExclusive();
      log.push('bash-enter');
      await new Promise((r) => setTimeout(r, 20));
      log.push('bash-exit');
      rel();
    };
    const fileWriter = async (p: string) => {
      const relGate = await gate.acquireShared();
      let relPath!: () => void;
      try {
        relPath = await pathMutex.acquire(p);
        log.push(`file-enter-${p}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`file-exit-${p}`);
      } finally {
        relPath();
        relGate();
      }
    };

    // bash starts first; file writer must not enter until bash exits.
    const bp = bashWriter();
    await new Promise((r) => setTimeout(r, 5));
    await fileWriter('/a.ts');
    await bp;
    const bashExit = log.indexOf('bash-exit');
    const fileEnter = log.indexOf('file-enter-/a.ts');
    expect(bashExit).toBeGreaterThanOrEqual(0);
    expect(fileEnter).toBeGreaterThan(bashExit);
  });
});

describe('toolLabel', () => {
  const call = (name: string, args: any) => ({
    id: '1',
    function: { name, arguments: JSON.stringify(args) },
  });

  it('uses the path for path-based tools', () => {
    expect(toolLabel(call('read', { path: 'src/a.ts' }))).toBe('read src/a.ts');
    expect(toolLabel(call('write', { path: 'b.ts' }))).toBe('write b.ts');
  });

  it('uses the pattern for grep', () => {
    expect(toolLabel(call('grep', { pattern: 'TODO' }))).toBe('grep TODO');
  });

  it('uses the cmd for bash', () => {
    expect(toolLabel(call('bash', { cmd: 'ls -la' }))).toBe('bash ls -la');
  });

  it('falls back to just the name when no known arg / bad JSON', () => {
    expect(toolLabel(call('list', {}))).toBe('list');
    expect(toolLabel({ id: '1', function: { name: 'read', arguments: '{bad json' } })).toBe('read');
  });
});

describe('computeMaxConcurrency', () => {
  it('returns 0 for no windows', () => {
    expect(computeMaxConcurrency([])).toBe(0);
  });

  it('returns 1 for a single window', () => {
    expect(computeMaxConcurrency([{ start: 0, end: 10 }])).toBe(1);
  });

  it('returns 1 for back-to-back (non-overlapping) windows', () => {
    expect(computeMaxConcurrency([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ])).toBe(1);
  });

  it('counts overlaps: three fully-overlapping windows => 3', () => {
    expect(computeMaxConcurrency([
      { start: 0, end: 30 },
      { start: 5, end: 25 },
      { start: 10, end: 20 },
    ])).toBe(3);
  });

  it('counts partial overlap', () => {
    expect(computeMaxConcurrency([
      { start: 0, end: 15 },
      { start: 10, end: 30 },
      { start: 20, end: 40 },
    ])).toBe(2);
  });
});

