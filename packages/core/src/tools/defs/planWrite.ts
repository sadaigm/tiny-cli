import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
  // plan_write
  const planWriteDef: ToolDefinition = {
    name: 'plan_write',
    description: 'Write a planning document to the session plan folder. Use this to save your implementation plan.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path for the plan file (e.g., plan.md)' },
        content: { type: 'string', description: 'Contents of the plan' }
      },
      required: ['path', 'content']
    }
  };
  registry.register(planWriteDef, async (args, context) => {
    if (!context?.sessionId) {
      return 'Error: Session ID is required for plan_write tool.';
    }

    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid.';
    if (args.content === undefined) return 'Error: "content" argument is missing.';

    const ext = path.extname(args.path).toLowerCase();
    const allowedExtensions = ['.md', '.txt'];
    if (!allowedExtensions.includes(ext)) {
        return `Error: plan_write only allows document files (${allowedExtensions.join(', ')}). Received: ${ext}`;
    }

    const planDir = path.join(process.cwd(), '.tiny-cli', context.sessionId, 'plan');
    try {
      await mkdir(planDir, { recursive: true });
      const fullPath = path.join(planDir, args.path);
      await writeFile(fullPath, args.content, 'utf-8');
      return `Successfully wrote plan to ${fullPath}`;
    } catch (error: any) {
      return `Error writing plan: ${error.message}`;
    }
  });
}
