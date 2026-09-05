import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
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
}
