import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../types.js';
import { ToolRegistry } from './registry.js';

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

export function registerDefaultTools(registry: ToolRegistry) {
  // bash
  const bashDef: ToolDefinition = {
    name: 'bash',
    description: [
      'Execute a shell command in your environment (runs through /bin/sh).',
      '',
      'How to use:',
      '1. Provide a single `cmd` string. It may chain multiple commands with && ; and pipes |.',
      '2. The FULL combined stdout+stderr of every segment is returned, even if a segment exits non-zero.',
      '3. Non-zero exit is NOT treated as a tool failure — read the output to judge success.',
      '',
      'Notes: prefer dedicated tools where they fit (read a file -> `read`, find by name -> `glob`,',
      'search contents -> `grep`). This is a mutating tool (guarded by the permission system).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The shell command(s) to execute; may chain with && ; |' }
      },
      required: ['cmd']
    },
    isModifying: true
  };
  registry.register(bashDef, async (args) => {
    let command = args.cmd;
    if (typeof command !== 'string') {
      return 'Tool error: cmd must be a shell command string.';
    }
    return new Promise((resolve) => {
      // A non-zero exit is data, not a tool failure: chains like
      // `cd X && ls missing-file` should surface BOTH the successful echo
      // output AND the ls stderr, so the model can read the whole picture
      // instead of bailing on the first failing segment. Only treat a total
      // inability to run (nothing on stdout/stderr, e.g. command not found)
      // as a genuine error. stdout and stderr are merged like a real shell.
      exec(command as string, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (combined) {
          resolve(combined);
        } else if (err) {
          resolve(`Error: ${err.message}`);
        } else {
          resolve('Command executed successfully (no output).');
        }
      });
    });
  });

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

  registry.register(readDef, async (args) => {
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing.';
    const fullPath = path.resolve(process.cwd(), args.path);
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

  // create_skill
  const createSkillDef: ToolDefinition = {
    name: 'create_skill',
    description:
      'Create a new agent skill. Writes a SKILL.md (frontmatter + body) into the skills directory. ' +
      'You must author the body yourself — a Markdown procedure for an agent to follow, not user docs.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name: lowercase a-z, 0-9, hyphens; 1-64 chars',
        },
        description: {
          type: 'string',
          description: 'One sentence: what the skill does + when to use it (under 1024 chars)',
        },
        body: {
          type: 'string',
          description: 'Markdown body of SKILL.md (starts with "# <Title>", imperative steps the agent executes)',
        },
        location: {
          type: 'string',
          description: "Where the skill lives: 'project' (.tiny-cli/skills/, shared) or 'global' (~/.tiny-cli/agent/skills/, personal). Default: project",
        },
      },
      required: ['name', 'description', 'body'],
    },
    isModifying: true,
  };
  registry.register(createSkillDef, async (args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const location = args.location === 'global' ? 'global' : 'project';

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      return 'Error: "name" is invalid. Use lowercase a-z, 0-9 and single hyphens (1-64 chars), e.g. "testcase-writer".';
    }
    if (!description) {
      return 'Error: "description" argument is missing. Write one sentence stating what the skill does and when to use it.';
    }
    if (description.length > 1024) {
      return 'Error: "description" must be under 1024 characters.';
    }
    if (!body.trim()) {
      return 'Error: "body" argument is missing. You must author the full Markdown procedure yourself and retry. Do not ask the user for it.';
    }

    const skillsRoot =
      location === 'global'
        ? path.join(process.env.HOME || '', '.tiny-cli', 'agent', 'skills')
        : path.resolve(process.cwd(), '.tiny-cli', 'skills');
    const skillDir = path.join(skillsRoot, name);
    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`,
        'utf-8',
      );
      return `Successfully created skill "${name}" at ${skillDir}/SKILL.md (${location}). It is picked up on the next session (or immediately via discovery).`;
    } catch (error: any) {
      return `Error creating skill "${name}": ${error.message}`;
    }
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
    description: [
      'Searches file CONTENTS for a pattern, recursively across a directory (or in a single file).',
      'Use this to find WHERE a symbol/string/function is used or defined.',
      '',
      'How to use:',
      '1. Provide a `pattern` (extended/POSIX ERE regular expression: supports | alternation, .* + ?, and char classes like [A-Z]).',
      '2. Provide a `path` to a file or directory (relative to the project root, e.g. "packages/core/src").',
      '3. Returns "file:line:matched-line" for each hit, or "No matches found." if none.',
      '',
      'Notes: searches source files only (*.ts/*.tsx/*.js/*.jsx/*.json/*.md).',
      'Finding a file by NAME/location -> use `glob`. Reading a file -> use `read`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regex (ERE) to match against file contents, e.g. "handleModelCommand|fetchModels"' },
        path: { type: 'string', description: 'The file or directory to search in, relative to the project root (e.g. "packages/core/src")' }
      },
      required: ['pattern', 'path']
    }
  };
  registry.register(grepDef, async (args) => {
    if (!args.pattern || typeof args.pattern !== 'string') return 'Error: "pattern" argument is missing or invalid.';
    if (!args.path || typeof args.path !== 'string') return 'Error: "path" argument is missing or invalid.';
    const fullPath = path.resolve(process.cwd(), args.path);
    // -E: extended regex (the model emits alternation '|', which is only valid
    // in ERE; in BRE it is treated as a literal and often errors). --include
    // keeps us out of node_modules/dist noise. We pass args via execFile-style
    // array to avoid shell-quoting bugs in the pattern/path.
    return new Promise((resolve) => {
      const child = execFile('grep', ['-rInE', '--include=*.{ts,tsx,js,jsx,json,md}', args.pattern, fullPath], (err, stdout, stderr) => {
        // grep exits 1 when there are NO matches — that is success, not an error.
        if (err && (err as any).code === 1 && !stderr) {
          resolve('No matches found.');
          return;
        }
        if (err) {
          resolve(`Error: ${stderr || (err as Error).message}`);
          return;
        }
        resolve(stdout || 'No matches found.');
      });
    });
  });

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
  // manage_tasks
  const manageTasksDef: ToolDefinition = {
    name: 'manage_tasks',
    description: 'Manage the current project task list (current_task.md).',
    parameters: {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['list', 'mark_done', 'add'],
          description: 'Action to perform: list tasks, mark a task as done, or add a new task.'
        },
        taskIndex: { 
          type: 'number', 
          description: 'The 1-based index of the task to mark as done (required for mark_done).' 
        },
        taskText: { 
          type: 'string', 
          description: 'The text of the new task to add (required for add).' 
        }
      },
      required: ['action']
    }
  };

  registry.register(manageTasksDef, async (args, context) => {
    if (!context?.sessionId) return "Error: No session ID found. Cannot manage tasks.";
    
    const planDir = path.join(context.cwd || process.cwd(), '.tiny-cli', context.sessionId, 'plan');
    const taskPath = path.join(planDir, 'current_task.md');
    
    try {
      const content = await readFile(taskPath, 'utf-8');
      const lines = content.split('\n');
      
      if (args.action === 'list') {
        return content;
      }
      
      if (args.action === 'mark_done') {
        if (args.taskIndex === undefined) return "Error: taskIndex is required for mark_done.";
        
        let currentIdx = 0;
        let modified = false;
        const newLines = lines.map(line => {
          if (line.trim().startsWith('- [')) {
            currentIdx++;
            if (currentIdx === args.taskIndex) {
              modified = true;
              return line.replace(/\[\s\]/, '[x]');
            }
          }
          return line;
        });
        
        if (!modified) return `Error: Task index ${args.taskIndex} not found or already completed.`;
        await writeFile(taskPath, newLines.join('\n'), 'utf-8');
        return `Successfully marked task ${args.taskIndex} as completed.`;
      }
      
      if (args.action === 'add') {
        if (!args.taskText) return "Error: taskText is required for add.";
        const newLines = [...lines, `- [ ] ${args.taskText}`];
        await writeFile(taskPath, newLines.join('\n'), 'utf-8');
        return `Successfully added new task: ${args.taskText}`;
      }
      
      return "Error: Invalid action.";
    } catch (e: any) {
      return `Error: Could not access task list: ${e.message}`;
    }
  });
  // mark_task_complete
  const markTaskCompleteDef: ToolDefinition = {
    name: 'mark_task_complete',
    description: 'Signal that the current task is fully implemented and verified.',
    parameters: {
      type: 'object',
      properties: {
        notes: { type: 'string', description: 'Optional notes about the implementation' }
      }
    }
  };

  registry.register(markTaskCompleteDef, async (args, context) => {
    if (!context?.sessionId) return "Error: No session ID found.";
    
    // This is primarily a signal for the orchestrator. 
    // We also use manage_tasks logic to actually mark it in the file.
    const planDir = path.join(context.cwd || process.cwd(), '.tiny-cli', context.sessionId, 'plan');
    const taskPath = path.join(planDir, 'current_task.md');
    
    try {
      // No plan file → not a planned session; nothing to mark. Say so
      // calmly instead of surfacing an ENOENT error to the model.
      let content: string;
      try {
        content = await readFile(taskPath, 'utf-8');
      } catch {
        return `No active plan for this session — nothing to mark. Treat this as confirmation the task is complete.${args.notes ? ' Notes: ' + args.notes : ''}`;
      }
      const lines = content.split('\n');

      // Find the first incomplete task and mark it done
      let modified = false;
      const newLines = lines.map(line => {
        if (!modified && line.trim().startsWith('- [ ]')) {
          modified = true;
          return line.replace(/\[\s\]/, '[x]');
        }
        return line;
      });
      
      if (!modified) return "Warning: No incomplete tasks found in the plan to mark as done.";
      
      await writeFile(taskPath, newLines.join('\n'), 'utf-8');
      return `Task successfully marked as complete.${args.notes ? ' Notes: ' + args.notes : ''}`;
    } catch (e: any) {
      return `Error updating task status: ${e.message}`;
    }
  });
}
