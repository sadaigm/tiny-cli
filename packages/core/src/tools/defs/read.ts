import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';
import { guardPath } from '../bashGuard.js';

export function register(registry: ToolRegistry) {
  // read
  const readDef: ToolDefinition = {
    name: 'read',
    description: 'Read a file. Can read the first 250 lines, a specific range, or the last 100 lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        first250: { type: 'boolean', description: 'Read the first 250 lines' },
        last100: { type: 'boolean', description: 'Read the last 100 lines' },
        startLine: { type: 'number', description: 'Start of range' },
        endLine: { type: 'number', description: 'End of range' }
      },
      required: ['path']
    }
  };

  registry.register(readDef, async (args, context) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing.';
    const fullPath = path.resolve(process.cwd(), args.path);
    if (context?.securedMode !== false) {
      const guard = guardPath(fullPath, process.cwd());
      if (guard) return guard;
    }
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const total = lines.length;

    let start = 0;
    let end = total;

    if (args.first250) {
      start = 0;
      end = Math.min(250, total);
    } else if (args.last100) {
      start = Math.max(0, total - 100);
      end = total;
    } else if (args.startLine !== undefined || args.endLine !== undefined) {
      // Use provided range, default to 500 lines from start if end is missing
      start = args.startLine !== undefined ? Math.max(0, (args.startLine as number) - 1) : 0;
      end = args.endLine !== undefined ? Math.min(total, (args.endLine as number)) : Math.min(total, start + 500);
    } else {
      // Default behavior if nothing specified: First 500
      start = 0;
      end = Math.min(500, total);
    }

    const result = lines.slice(start, end).map((l, i) => `${(start + i + 1).toString().padStart(4, ' ')}: ${l}`).join('\n');
    const header = `[FILE: ${args.path} | TOTAL LINES: ${total} | SHOWING: ${start + 1} to ${end}]\n`;
    return header + result;
  });
}
