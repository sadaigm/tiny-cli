import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
  // list
  const listDef: ToolDefinition = {
    name: 'list',
    description: 'List contents of a directory. Defaults to the current working directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional path to the directory. Defaults to the current working directory.' }
      },
      required: []
    }
  };
  registry.register(listDef, async (args) => {
    const target = typeof args.path === 'string' && args.path ? args.path : '.';
    const fullPath = path.resolve(process.cwd(), target);
    const files = await readdir(fullPath, { withFileTypes: true });
    return files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE] '}${f.name}`).join('\n');
  });
}
