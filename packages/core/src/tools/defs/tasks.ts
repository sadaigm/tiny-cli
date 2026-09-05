import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
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
