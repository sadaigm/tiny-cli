import { exec } from 'child_process';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../types.js';
import { ToolRegistry } from './registry.js';

export function registerDefaultTools(registry: ToolRegistry) {
  // bash
  const bashDef: ToolDefinition = {
    name: 'bash',
    description: 'Execute a shell command in your environment.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to execute' }
      },
      required: ['cmd']
    }
  };
  registry.register(bashDef, async (args) => {
    let command = args.cmd;
    if (typeof command !== 'string') {
      return 'Tool error: cmd must be a shell command string.';
    }
    return new Promise((resolve) => {
      exec(command as string, (err, stdout, stderr) => {
        if (err) {
          resolve(`Error: ${err.message}\n${stderr}`);
        } else {
          resolve(stdout || stderr || 'Command executed successfully (no output).');
        }
      });
    });
  });

  // read
  const readDef: ToolDefinition = {
    name: 'read',
    description: 'Read the contents of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' }
      },
      required: ['path']
    }
  };
  registry.register(readDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid.';
    const fullPath = path.resolve(process.cwd(), args.path);
    return await readFile(fullPath, 'utf-8');
  });

  // write
  const writeDef: ToolDefinition = {
    name: 'write',
    description: 'Create or overwrite a file with specific content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Contents to write' }
      },
      required: ['path', 'content']
    }
  };
  registry.register(writeDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid. You must provide the file path.';
    if (args.content === undefined) return 'Error: "content" argument is missing. You must provide the content to write.';
    const fullPath = path.resolve(process.cwd(), args.path);
    await writeFile(fullPath, args.content, 'utf-8');
    return `Successfully wrote to ${args.path}`;
  });

  // list
  const listDef: ToolDefinition = {
    name: 'list',
    description: 'List contents of a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory' }
      },
      required: ['path']
    }
  };
  registry.register(listDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid.';
    const fullPath = path.resolve(process.cwd(), args.path);
    const files = await readdir(fullPath, { withFileTypes: true });
    return files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE] '}${f.name}`).join('\n');
  });

  // grep
  const grepDef: ToolDefinition = {
    name: 'grep',
    description: 'Searches for patterns in file contents.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The pattern to search for' },
        path: { type: 'string', description: 'The file or directory to search in' }
      },
      required: ['pattern', 'path']
    }
  };
  registry.register(grepDef, async (args) => {
    if (!args.pattern || typeof args.pattern !== 'string') return 'Error: "pattern" argument is missing or invalid.';
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid.';
    const fullPath = path.resolve(process.cwd(), args.path);
    return new Promise((resolve) => {
      exec(`grep -rIn "${args.pattern}" "${fullPath}"`, (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve(`No matches found or Error: ${err.message}`);
        } else {
          resolve(stdout || 'No matches found.');
        }
      });
    });
  });

  // glob
  const globDef: ToolDefinition = {
    name: 'glob',
    description: 'Finds files based on pattern matching.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern (e.g. src/**/*.ts)' }
      },
      required: ['pattern']
    }
  };
  registry.register(globDef, async (args) => {
    if (!args.pattern || typeof args.pattern !== 'string') return 'Error: "pattern" argument is missing or invalid.';
    return new Promise((resolve) => {
      exec(`bash -c "ls -1 ${args.pattern}"`, (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve(`No files found or Error: ${err.message}`);
        } else {
          resolve(stdout || 'No files found.');
        }
      });
    });
  });

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
