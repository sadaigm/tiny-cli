import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
  // memory
  const memoryDef: ToolDefinition = {
    name: 'memory',
    description: [
      'Persist and retrieve project knowledge across sessions. Create, update, delete, or list memory entries.',
      '',
      'Actions:',
      '- create: Add a new memory entry with name, description, type, and content',
      '- update: Overwrite an existing memory entry',
      '- delete: Remove a memory entry and its index line',
      '- list: Show all available memory entries',
      '',
      'Memory types: user (preferences), feedback (corrections), project (patterns), reference (links)',
      '',
      'Use this when:',
      '- User explicitly asks to remember/save something',
      '- User corrects you and you want to avoid repeating the mistake',
      '- You discover a clear recurring pattern worth remembering',
      '',
      'When NOT to use:',
      '- Do not automatically save every interaction',
      '- Do not save without user intent or clear value',
      '- Do not save ephemeral things (single-use commands, temporary context)',
      '',
      'Best practices:',
      '- Be concise (1-5 sentences preferred)',
      '- Focus on patterns/preferences, not one-off details',
      '- Use specific descriptions for keyword matching',
      '- User preferences: keep under 500 chars',
      '- Corrections: keep under 300 chars',
      '- Patterns: keep under 500 chars',
      '- Links: keep under 200 chars'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list'],
          description: 'Action to perform on memory'
        },
        name: {
          type: 'string',
          description: 'Memory identifier (kebab-case slug), e.g. no-co-author-commits'
        },
        description: {
          type: 'string',
          description: 'One-line summary of what this memory stores'
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory category for organization'
        },
        content: {
          type: 'string',
          description: 'Memory content body (markdown). Use [[other-name]] to link related memories.'
        }
      },
      required: ['action']
    },
    isModifying: true
  };

  registry.register(memoryDef, async (args, context) => {
    const cwd = context?.cwd || process.cwd();
    const memoryDir = path.join(cwd, '.tiny-cli', 'memory');
    const indexPath = path.join(memoryDir, 'MEMORY.md');

    switch (args.action) {
      case 'create':
      case 'update': {
        if (!args.name || typeof args.name !== 'string') {
          return 'Error: create/update requires name (kebab-case string)';
        }
        if (!args.description || typeof args.description !== 'string') {
          return 'Error: create/update requires description (one-line summary)';
        }
        if (!args.type || typeof args.type !== 'string') {
          return 'Error: create/update requires type (user|feedback|project|reference)';
        }
        if (!args.content || typeof args.content !== 'string') {
          return 'Error: create/update requires content (markdown body)';
        }

        // Validate name is kebab-case
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(args.name)) {
          return 'Error: name must be kebab-case (lowercase a-z, 0-9, hyphens only)';
        }

        try {
          await mkdir(memoryDir, { recursive: true });

          // Write memory file with frontmatter
          const memoryPath = path.join(memoryDir, `${args.name}.md`);
          const frontmatter = `---
name: ${args.name}
description: ${args.description}
metadata:
  type: ${args.type}
---

${args.content}`;
          await writeFile(memoryPath, frontmatter, 'utf-8');

          // Update index
          const indexLine = `- [${args.description}](${args.name}.md) — ${args.type}`;
          let indexContent = '';
          try {
            indexContent = await readFile(indexPath, 'utf-8');
          } catch {
            // Index doesn't exist yet
          }

          // Remove existing line if updating (match by name, not description, since description might change)
          const existingRegex = new RegExp(`^- \\[.*\\]\\(${args.name}\\.md\\).*\\n?`, 'm');
          indexContent = indexContent.replace(existingRegex, '');

          // Append new line
          indexContent = indexContent.trim() + '\n' + indexLine + '\n';
          await writeFile(indexPath, indexContent, 'utf-8');

          return `Memory "${args.name}" ${args.action === 'create' ? 'created' : 'updated'} successfully. It will be available in the next session.`;
        } catch (error: any) {
          return `Error ${args.action === 'create' ? 'creating' : 'updating'} memory: ${error.message}`;
        }
      }

      case 'delete': {
        if (!args.name || typeof args.name !== 'string') {
          return 'Error: delete requires name';
        }

        const memoryPath = path.join(memoryDir, `${args.name}.md`);
        try {
          await fs.promises.unlink(memoryPath);

          // Remove from index
          let indexContent = await readFile(indexPath, 'utf-8');
          const lineRegex = new RegExp(`^- .*\\(${args.name}\\.md\\).*\\n?`, 'm');
          indexContent = indexContent.replace(lineRegex, '');
          await writeFile(indexPath, indexContent.trim() + '\n', 'utf-8');

          return `Memory "${args.name}" deleted successfully.`;
        } catch (error: any) {
          return `Memory "${args.name}" not found or could not be deleted: ${error.message}`;
        }
      }

      case 'list': {
        try {
          const indexContent = await readFile(indexPath, 'utf-8');
          return `Available memories:\n${indexContent}`;
        } catch {
          return 'No memories found. Use memory tool with action=create to add memories.';
        }
      }

      default:
        return `Unknown action: ${args.action}. Use create|update|delete|list.`;
    }
  });
}
