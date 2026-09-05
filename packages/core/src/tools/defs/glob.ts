import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

/**
 * fs.promises.glob (Node >=22) is present at runtime but absent from
 * @types/node@20. It returns an async iterable of matched paths (not an
 * array). Bind it through the fs namespace with a minimal typed signature
 * and a collector, so the glob tool uses native globbing (no shell, real
 * `**` recursion) without a dependency bump. */
const fsGlob = (
  (fs as unknown as { promises: { glob: (pattern: string, opts?: { cwd?: string }) => AsyncIterable<string> } }).promises.glob
);
async function collectGlob(pattern: string, cwd: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of fsGlob(pattern, { cwd })) out.push(entry);
  return out;
}

export function register(registry: ToolRegistry) {
  // glob
  const globDef: ToolDefinition = {
    name: 'glob',
    description: [
      'Finds files by NAME/path using glob patterns (NOT by content — use `grep` for content).',
      'Use this to LOCATE files: e.g. all test files, a config, or a component by name.',
      '',
      'How to use:',
      '1. Provide a `pattern`. Supports `*` (one segment), `**` (any depth), and `?`.',
      '2. Patterns are relative to the project root.',
      '3. Returns one matched path per line, or "No files found." if none.',
      '',
      'Examples: "packages/**/*.test.ts" (all tests), "**/*.config.js", "src/components/*.tsx".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to project root, e.g. "packages/**/*.test.ts"' }
      },
      required: ['pattern']
    }
  };
  registry.register(globDef, async (args) => {
    if (!args.pattern || typeof args.pattern !== 'string') return 'Error: "pattern" argument is missing or invalid.';
    try {
      // Native globbing (Node >=22 fs.glob): no shell, so the pattern can never
      // inject commands, and `**` recurses properly. The old `ls -1 ${pattern}`
      // only expanded against the cwd and silently dropped `**`.
      // fs.glob is present at runtime but absent from @types/node@20, so bind
      // it through the fs namespace with a minimal typed shim.
      const matches = await collectGlob(args.pattern, process.cwd());
      return matches.length ? matches.join('\n') : 'No files found.';
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  });
}
