import { exec } from 'child_process';
import { readFile, writeFile, readdir } from 'fs/promises';
import { ToolDefinition } from '../types.js';
import { ToolRegistry } from './registry.js';

export function registerDefaultTools(registry: ToolRegistry) {
  // runCommand
  const runCommandDef: ToolDefinition = {
    name: 'runCommand',
    description: 'Execute a shell command.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The command to execute' }
      },
      required: ['cmd']
    }
  };
  // registry.register(runCommandDef, async (args) => {
  //   let command = args.cmd;
  //   // Guard: model passed schema object instead of a string value
  //   if (typeof command !== 'string') {
  //     if (Array.isArray(command)) {
  //       command = command.join(' ');
  //     } else {
  //       return 'Tool error: cmd must be a shell command string, not an object.';
  //     }
  //   }
  //   return new Promise((resolve) => {
  //     exec(command as string, (err, stdout, stderr) => {
  //       if (err) {
  //         resolve(`Error: ${err.message}\n${stderr}`);
  //       } else {
  //         resolve(stdout || stderr || 'Command executed successfully (no output).');
  //       }
  //     });
  //   });
  // });

  // readFile
  const readFileDef: ToolDefinition = {
    name: 'readFile',
    description: 'Read the contents of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' }
      },
      required: ['path']
    }
  };
  registry.register(readFileDef, async (args) => {
    return await readFile(args.path, 'utf-8');
  });

  // writeFile
  const writeFileDef: ToolDefinition = {
    name: 'writeFile',
    description: 'Write content to a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Contents to write' }
      },
      required: ['path', 'content']
    }
  };
  registry.register(writeFileDef, async (args) => {
    await writeFile(args.path, args.content, 'utf-8');
    return `Successfully wrote to ${args.path}`;
  });

  // listDir
  const listDirDef: ToolDefinition = {
    name: 'listDir',
    description: 'List contents of a directory. use this tool only when analyzing the file structure of a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory' }
      },
      required: ['path']
    }
  };
  registry.register(listDirDef, async (args) => {
    const files = await readdir(args.path, { withFileTypes: true });
    return files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE] '}${f.name}`).join('\n');
  });
}
