import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { InputHistory, DEFAULT_HISTORY_LIMIT } from '../src/tui/utils/inputHistory.js';
import { loadHistory, saveHistory } from '../src/tui/utils/historyStore.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-cli-history-'));
});

async function seed(file: string, projects: Record<string, string[]>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects }));
}

describe('historyStore round-trip', () => {
  it('saves and reloads the same entries', async () => {
    const file = path.join(dir, 'history.json');
    const history = new InputHistory();
    history.push('first');
    history.push('second');
    await saveHistory(history, { file, projectDir: dir });

    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.toArray()).toEqual(['first', 'second']);
  });

  it('recalls the newest entry first after a reload', async () => {
    const file = path.join(dir, 'history.json');
    const history = new InputHistory();
    history.push('oldest');
    history.push('newest');
    await saveHistory(history, { file, projectDir: dir });

    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.move(-1)).toBe('newest');
    expect(loaded.move(-1)).toBe('oldest');
  });

  it('keeps projects in the same file isolated by bucket', async () => {
    const file = path.join(dir, 'history.json');
    const a = new InputHistory();
    a.push('from project a');
    await saveHistory(a, { file, projectDir: '/tmp/project-a' });

    const b = new InputHistory();
    b.push('from project b');
    await saveHistory(b, { file, projectDir: '/tmp/project-b' });

    const loadedA = await loadHistory({ file, projectDir: '/tmp/project-a' });
    expect(loadedA.toArray()).toEqual(['from project a']);
    const loadedB = await loadHistory({ file, projectDir: '/tmp/project-b' });
    expect(loadedB.toArray()).toEqual(['from project b']);
  });

  it('appends: saving again merges with existing entries', async () => {
    const file = path.join(dir, 'history.json');
    const first = new InputHistory();
    first.push('one');
    await saveHistory(first, { file, projectDir: dir });

    const second = new InputHistory();
    second.push('one');
    second.push('two');
    await saveHistory(second, { file, projectDir: dir });

    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.toArray()).toEqual(['one', 'two']);
  });

  it('caps the persisted bucket at DEFAULT_HISTORY_LIMIT', async () => {
    const file = path.join(dir, 'history.json');
    const history = new InputHistory();
    for (let i = 0; i < DEFAULT_HISTORY_LIMIT + 25; i++) history.push(`line ${i}`);
    await saveHistory(history, { file, projectDir: dir });

    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.length).toBe(DEFAULT_HISTORY_LIMIT);
    expect(loaded.toArray()[0]).toBe(`line ${25}`);
  });

  it('drops the bucket when history is empty', async () => {
    const file = path.join(dir, 'history.json');
    await seed(file, { 'old-bucket': ['stale'] });
    await saveHistory(new InputHistory(), { file, projectDir: dir });

    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(Object.keys(raw.projects)).toEqual(['old-bucket']);

    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.isEmpty).toBe(true);
  });
});

describe('historyStore resilience', () => {
  it('returns an empty history when the file is missing', async () => {
    const loaded = await loadHistory({ file: path.join(dir, 'nope.json'), projectDir: dir });
    expect(loaded.isEmpty).toBe(true);
  });

  it('returns an empty history when the file is corrupt', async () => {
    const file = path.join(dir, 'history.json');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, '{not json');
    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.isEmpty).toBe(true);
  });

  it('skips non-string entries instead of crashing', async () => {
    const file = path.join(dir, 'history.json');
    // Bucket key is a hash, so write via the public API's sibling shape:
    // corrupt entries are ignored, valid ones survive.
    const history = new InputHistory();
    history.push('valid');
    await saveHistory(history, { file, projectDir: dir });
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    const key = Object.keys(raw.projects)[0];
    raw.projects[key] = [42, null, 'valid'];
    await fs.writeFile(file, JSON.stringify(raw));

    const loaded = await loadHistory({ file, projectDir: dir });
    expect(loaded.toArray()).toEqual(['valid']);
  });

  it('saveHistory resolves (does not throw) when the dir is unwritable', async () => {
    const history = new InputHistory();
    history.push('entry');
    await expect(
      saveHistory(history, {
        file: path.join('/proc', 'tiny-cli-history.json'),
        projectDir: dir,
      }),
    ).resolves.toBeUndefined();
  });
});
