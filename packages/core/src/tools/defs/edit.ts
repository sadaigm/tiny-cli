import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
  // search_replace
  const searchReplaceDef: ToolDefinition = {
    name: 'search_replace',
    description: 'Surgically replace a block of text in a file. Requires an exact match of the search block including whitespace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        search: { type: 'string', description: 'The exact block of text to find' },
        replace: { type: 'string', description: 'The text to replace it with' }
      },
      required: ['path', 'search', 'replace']
    },
    isModifying: true
  };
  registry.register(searchReplaceDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing.';
    const fullPath = path.resolve(process.cwd(), args.path);
    const content = await readFile(fullPath, 'utf-8');
    
    // Normalize line endings for matching
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const normalizedSearch = (args.search as string).replace(/\r\n/g, '\n');
    const normalizedReplace = (args.replace as string).replace(/\r\n/g, '\n');

    const parts = normalizedContent.split(normalizedSearch);
    if (parts.length === 1) {
      return 'Error: Search block not found. Ensure exact match including whitespace and indentation.';
    }
    if (parts.length > 2) {
      return 'Error: Search block found multiple times. Please provide a more unique search block.';
    }

    const newContent = parts.join(normalizedReplace);
    await writeFile(fullPath, newContent, 'utf-8');
    return `Successfully updated ${args.path}`;
  });

  // insert_lines
  const insertLinesDef: ToolDefinition = {
    name: 'insert_lines',
    description: 'Insert text at a specific line number in a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        line: { type: 'number', description: 'Line number to insert at (1-indexed)' },
        content: { type: 'string', description: 'Text to insert' },
        position: { type: 'string', enum: ['before', 'after'], description: 'Insert before or after the line (default: after)' }
      },
      required: ['path', 'line', 'content']
    },
    isModifying: true
  };
  registry.register(insertLinesDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing.';
    const fullPath = path.resolve(process.cwd(), args.path);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    
    const lineNum = args.line as number;
    const position = (args.position as string) || 'after';
    const index = position === 'before' ? lineNum - 1 : lineNum;
    
    lines.splice(index, 0, args.content as string);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    return `Successfully inserted lines into ${args.path} at line ${lineNum} (${position})`;
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
    },
    isModifying: true
  };
  registry.register(writeDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid. You must provide the file path.';
    if (args.content === undefined) return 'Error: "content" argument is missing. You must generate the full file content yourself and retry the write with a complete "content" string. Do not ask the user for it.';
    const fullPath = path.resolve(process.cwd(), args.path);
    try {
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, args.content, 'utf-8');
      return `Successfully wrote to ${args.path}`;
    } catch (error: any) {
      return `Error writing to ${args.path}: ${error.message}`;
    }
  });
}
