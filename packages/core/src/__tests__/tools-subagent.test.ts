jest.mock('node-fetch', () => ({ default: jest.fn() }));
jest.mock('@tiny-cli/resources', () => ({
  loadSkills: jest.fn().mockResolvedValue({ skills: [], warnings: [] }),
  renderSkillsXml: jest.fn().mockReturnValue(''),
}));

import { ToolRegistry } from '../tools/registry.js';
import { register } from '../tools/defs/subAgent.js';
import { SubAgentManager } from '../subagent/manager.js';
import { Agent } from '../agent.js';
import fs from 'fs/promises';
import path from 'path';

describe('Sub-agent tools (assign_task, check_sub, send_to_sub, ask_mentor)', () => {
  let registry: ToolRegistry;
  let manager: SubAgentManager;
  const testSessionId = 'test-tools-parent-123';

  beforeEach(() => {
    registry = new ToolRegistry();
    register(registry);
    manager = new SubAgentManager(testSessionId, [
      {
        name: 'test-worker',
        model: 'llama3.2:latest',
        endpoint: 'http://localhost:11434/v1',
      },
    ]);

    jest.spyOn(Agent.prototype, 'run').mockImplementation(async function () {
      return {
        content: 'Completed work on assigned task.',
        steps: [],
      };
    });
  });

  afterAll(async () => {
    try {
      await fs.rm(path.join(process.cwd(), '.tiny-cli', 'sessions', testSessionId), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore
    }
  });

  it('assign_task spawns a sub-agent and returns confirmation', async () => {
    const result = await registry.call(
      'assign_task',
      {
        task: 'Implement rate limiter',
        name: 'rate-limiter',
        profile: 'test-worker',
      },
      {
        sessionId: testSessionId,
        cwd: process.cwd(),
        subAgentManager: manager,
      }
    );

    expect(result).toContain('Sub-agent "rate-limiter"');
    expect(result).toContain('spawned successfully with model "llama3.2:latest"');

    const list = manager.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('rate-limiter');
  });

  it('check_sub lists all sub-agents or checks a specific one', async () => {
    const spawnResult = await registry.call(
      'assign_task',
      { task: 'Database migration', name: 'db-mig' },
      { sessionId: testSessionId, cwd: process.cwd(), subAgentManager: manager }
    );

    // List all
    const listResult = await registry.call('check_sub', { action: 'list' }, { subAgentManager: manager });
    expect(listResult).toContain('Active sub-agents');
    expect(listResult).toContain('db-mig');

    // Check specific sub-agent
    const sub = manager.list().find((s) => s.name === 'db-mig');
    expect(sub).toBeDefined();

    const statusResult = await registry.call(
      'check_sub',
      { id: sub!.id, action: 'status' },
      { subAgentManager: manager }
    );
    expect(statusResult).toContain(`Sub-agent "db-mig" (ID: ${sub!.id})`);

    // Wait for sub to finish
    const instance = manager.get(sub!.id);
    if (instance?.promise) await instance.promise;

    const summaryResult = await registry.call(
      'check_sub',
      { id: sub!.id, action: 'summary' },
      { subAgentManager: manager }
    );
    expect(summaryResult).toContain('Completed work on assigned task.');
  });

  it('send_to_sub delivers mentor feedback to the sub-agent', async () => {
    await registry.call(
      'assign_task',
      { task: 'Write tests', name: 'test-runner' },
      { sessionId: testSessionId, cwd: process.cwd(), subAgentManager: manager }
    );

    const sub = manager.list().find((s) => s.name === 'test-runner')!;
    const sendResult = await registry.call(
      'send_to_sub',
      { id: sub.id, message: 'Make sure test coverage is > 90%' },
      { subAgentManager: manager }
    );

    expect(sendResult).toContain('Direction successfully sent');
    const instance = manager.get(sub.id)!;
    expect(instance.mentorDirections).toContain('Make sure test coverage is > 90%');
  });

  it('ask_mentor submits question and returns acknowledgment', async () => {
    const result = await registry.call('ask_mentor', {
      question: 'Should rate limit be per-IP or per-token?',
      context: 'Both are feasible in the current schema',
    });

    expect(result).toContain('Question submitted to mentor: "Should rate limit be per-IP or per-token?"');
    expect(result).toContain('Context: Both are feasible in the current schema');
  });
});

