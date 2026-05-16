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
    },
    isModifying: true
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
    if (args.content === undefined) return 'Error: "content" argument is missing. You must provide the content to write.';
    const fullPath = path.resolve(process.cwd(), args.path);
    try {
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, args.content, 'utf-8');
      return `Successfully wrote to ${args.path}`;
    } catch (error: any) {
      return `Error writing to ${args.path}: ${error.message}`;
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
      const content = await readFile(taskPath, 'utf-8');
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
