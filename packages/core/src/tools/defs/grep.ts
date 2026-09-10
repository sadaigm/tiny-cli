import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';
import { guardPath } from '../bashGuard.js';

/** grep tool: extensions searched by default (noise control — lockfiles,
 *  assets and vendored code stay out of results unless opted in). */
const GREP_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'py', 'sh', 'css', 'scss', 'html', 'yaml', 'yml'];
/** grep tool: directories skipped by default. */
const GREP_EXCLUDE_DIRS = ['node_modules', 'dist', '.git'];

/**
 * Build the execFile argv for the grep tool. Pure so tests can assert the
 * filtering behavior without shelling out. -E = extended regex (the model
 * emits alternation '|', which is only valid in ERE); -I skips binary files;
 * -r recurses (and makes a single-file target just search that file).
 * execFile passes args verbatim (no shell), so brace expansion like
 * '*.{ts,tsx}' never expands — each extension needs its own --include flag.
 */
export function buildGrepArgs(pattern: string, target: string, includeExcluded?: boolean): string[] {
  if (includeExcluded) {
    return ['-rInE', pattern, target];
  }
  const includes = GREP_EXTENSIONS.map((ext) => `--include=*.${ext}`);
  const excludes = GREP_EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`);
  return ['-rInE', ...excludes, ...includes, pattern, target];
}

export function register(registry: ToolRegistry) {
  // grep
  const grepDef: ToolDefinition = {
    name: 'grep',
    description: [
      'Searches file CONTENTS for a pattern, recursively across a directory (or in a single file).',
      'Use this to find WHERE a symbol/string/function is used or defined.',
      '',
      'How to use:',
      '1. Provide a `pattern` (extended/POSIX ERE regular expression: supports | alternation, .* + ?, and char classes like [A-Z]).',
      '2. Optionally provide a `path` to a file or directory (relative to the project root). Defaults to the whole project.',
      '3. Returns "file:line:matched-line" for each hit (capped at 200 lines), or "No matches found." if none.',
      '',
      'Notes: by default skips node_modules/dist/.git and searches common source files',
      '(*.ts/*.tsx/*.js/*.jsx/*.mjs/*.cjs/*.json/*.md/*.py/*.sh/*.css/*.html/*.yml/*.yaml).',
      'Set includeExcluded=true to search EVERYTHING (all directories and file types) —',
      'use that when you specifically need code from node_modules or build output.',
      'Finding a file by NAME/location -> use `glob`. Reading a file -> use `read`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regex (ERE) to match against file contents, e.g. "handleModelCommand|fetchModels"' },
        path: { type: 'string', description: 'Optional file or directory to search (relative to the project root). Defaults to the whole project.' },
        includeExcluded: { type: 'boolean', description: 'Set true to also search node_modules/dist/.git and all file types (rare; for dependency/build-output searches).' }
      },
      required: ['pattern']
    }
  };
  registry.register(grepDef, async (args, context) => {
    if (!args.pattern || typeof args.pattern !== 'string') return 'Error: "pattern" argument is missing or invalid.';
    const target = typeof args.path === 'string' && args.path ? args.path : '.';
    const fullPath = path.resolve(process.cwd(), target);
    if (context?.securedMode !== false) {
      const guard = guardPath(fullPath, process.cwd());
      if (guard) return guard;
    }
    return new Promise((resolve) => {
      const child = execFile('grep', buildGrepArgs(args.pattern, fullPath, args.includeExcluded === true), { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        // grep exits 1 when there are NO matches — that is success, not an error.
        if (err && (err as any).code === 1 && !stderr) {
          resolve('No matches found.');
          return;
        }
        if (err) {
          resolve(`Error: ${stderr || (err as Error).message}`);
          return;
        }
        const lines = (stdout || '').split('\n').filter(Boolean);
        if (lines.length === 0) {
          resolve('No matches found.');
          return;
        }
        if (lines.length > 200) {
          resolve(lines.slice(0, 200).join('\n') + `\n... ${lines.length - 200} more matches truncated. Narrow the pattern or path, or grep a specific file.`);
          return;
        }
        resolve(lines.join('\n'));
      });
    });
  });
}
