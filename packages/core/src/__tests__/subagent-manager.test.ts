jest.mock('node-fetch', () => ({ default: jest.fn() }));
jest.mock('@tiny-cli/resources', () => ({
  loadSkills: jest.fn().mockResolvedValue({ skills: [], warnings: [] }),
  renderSkillsXml: jest.fn().mockReturnValue(''),
}));

import fs from 'fs/promises';
import path from 'path';
import { SubAgentManager } from '../subagent/manager.js';
import { Agent } from '../agent.js';

describe('SubAgentManager', () => {
  const testParentSessionId = 'test-parent-mgr-123';
  const expectedSubDir = path.join(process.cwd(), '.tiny-cli', 'sessions', testParentSessionId, 'sub');

  beforeEach(() => {
    // Mock agent.run to resolve quickly for testing
    jest.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent) {
      return {
        content: 'Mock task completed by sub-agent',
        steps: [],
      };
    });
  });

  afterAll(async () => {
    try {
      await fs.rm(path.join(process.cwd(), '.tiny-cli', 'sessions', testParentSessionId), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore cleanup
    }
  });

  it('spawns a sub-agent, runs in background, and persists session file', async () => {
    const manager = new SubAgentManager(testParentSessionId, [
      {
        name: 'test-worker',
        model: 'llama3.2:latest',
        endpoint: 'http://localhost:11434/v1',
      },
    ]);

    const instance = await manager.spawn({
      id: 'sub-test-1',
      name: 'worker-1',
      task: 'Build authentication endpoint',
      parentSessionId: testParentSessionId,
      profile: 'test-worker',
    });

    expect(instance.id).toBe('sub-test-1');
    expect(instance.name).toBe('worker-1');
    expect(instance.profile.model).toBe('llama3.2:latest');

    // Wait for the background task to complete
    if (instance.promise) {
      await instance.promise;
    }

    expect(instance.status).toBe('completed');
    expect(instance.summary).toBe('Mock task completed by sub-agent');

    // Verify session file exists at .tiny-cli/sessions/test-parent-mgr-123/sub/sub-test-1.json
    const sessionFile = path.join(expectedSubDir, 'sub-test-1.json');
    const content = await fs.readFile(sessionFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.metadata.id).toBe('sub-test-1');

    // Verify asset directory exists at .tiny-cli/sessions/test-parent-mgr-123/sub/sub-test-1/
    const assetDir = path.join(expectedSubDir, 'sub-test-1');
    const stat = await fs.stat(assetDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('lists sub-agent summaries', async () => {
    const manager = new SubAgentManager(testParentSessionId);
    const instance = await manager.spawn({
      id: 'sub-test-2',
      name: 'worker-2',
      task: 'Migrate database',
      parentSessionId: testParentSessionId,
    });

    if (instance.promise) {
      await instance.promise;
    }

    const list = manager.list();
    const found = list.find((s) => s.id === 'sub-test-2');
    expect(found).toBeDefined();
    expect(found!.name).toBe('worker-2');
    expect(found!.status).toBe('completed');
  });

  it('injects mentor directions via sendToSub', async () => {
    const manager = new SubAgentManager(testParentSessionId);
    const instance = await manager.spawn({
      id: 'sub-test-3',
      name: 'worker-3',
      task: 'Write tests',
      parentSessionId: testParentSessionId,
    });

    if (instance.promise) {
      await instance.promise;
    }

    // Sub-agent is now completed. Sending a direction re-triggers it with the feedback
    const sent = await manager.sendToSub('sub-test-3', 'Use vitest instead of jest');
    expect(sent).toBe(true);
    expect(instance.mentorDirections).toContain('Use vitest instead of jest');

    if (instance.promise) {
      await instance.promise;
    }
    expect(instance.status).toBe('completed');
  });

  it('kills a sub-agent with abortController', async () => {
    const manager = new SubAgentManager(testParentSessionId);

    // Make Agent.run hang so we can test kill
    jest.spyOn(Agent.prototype, 'run').mockImplementation(async () => {
      return new Promise(() => {}); // never resolves
    });

    const instance = await manager.spawn({
      id: 'sub-test-4',
      name: 'worker-4',
      task: 'Long running task',
      parentSessionId: testParentSessionId,
    });

    expect(instance.status).toBe('running');
    const killed = manager.kill('sub-test-4');
    expect(killed).toBe(true);
    expect(instance.abortController.signal.aborted).toBe(true);
    expect(instance.status).toBe('cancelled');
  });
});
