import { exec } from 'child_process';
import { readFile, writeFile, readdir } from 'fs/promises';
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
}
