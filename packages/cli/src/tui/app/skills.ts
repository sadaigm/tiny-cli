import type { Agent } from '@tiny-cli/core';
import type { AppDispatch } from './reducer.js';

/**
 * Skill slash-command handlers, extracted verbatim from app.tsx's
 * handleSlashCommand. Each takes exactly what the original block closed
 * over; each returns true (command handled).
 */

/** `/skill:<name> [args]` — send the skill's full SKILL.md content to the agent. */
export async function runSkillCommand(
  cmd: string,
  parts: string[],
  agent: Agent,
  addErrorLog: (content: string) => void,
  submitMessage: (text: string, displayText?: string) => void,
): Promise<boolean> {
  const cfg = agent.getConfig();
  if (cfg.enableSkillCommands === false) {
    addErrorLog('Skill commands are disabled (enableSkillCommands: false).');
    return true;
  }
  const skillName = cmd.slice('skill:'.length);
  const argsText = parts.slice(1).join(' ');
  try {
    const { loadSkills } = await import('@tiny-cli/resources');
    const result = await loadSkills(
      cfg.skillsOptions ?? { settingsSkills: [], cliSkills: [], noSkills: false, trusted: false }
    );
    const skill = result.skills.find((s) => s.name === skillName);
    if (!skill) {
      addErrorLog(`Unknown skill "${skillName}". Available: ${result.skills.map((s) => s.name).join(', ') || '(none)'}`);
      return true;
    }
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(skill.path, 'utf-8');
    submitMessage(argsText ? `${content}\n\nUser: ${argsText}` : content);
  } catch (err: any) {
    addErrorLog(`Skill command failed: ${err.message}`);
  }
  return true;
}

/** `/skills` — selector to activate/deactivate skills; active skill bodies are injected into the system prompt on every run. */
export async function listSkillsCommand(
  agent: Agent,
  dispatch: AppDispatch,
  addSystemLog: (content: string) => void,
  addErrorLog: (content: string) => void,
): Promise<boolean> {
  const cfg = agent.getConfig();
  try {
    const { loadSkills } = await import('@tiny-cli/resources');
    const result = await loadSkills(
      cfg.skillsOptions ?? { settingsSkills: [], cliSkills: [], noSkills: false, trusted: false }
    );
    if (result.skills.length === 0) {
      addSystemLog('No skills loaded. Add skills under ~/.tiny-cli/agent/skills/ or .tiny-cli/skills/.');
    } else {
      const active = new Set(cfg.activeSkills ?? []);
      dispatch({
        type: 'OPEN_SELECTOR',
        selector: {
          kind: 'skill',
          title: `Select Skill to activate/deactivate (active: ${active.size})`,
          items: result.skills.map((s) => ({
            label: `${active.has(s.name) ? '●' : '○'} ${s.name === 'create-skill' ? 'skills-generator' : s.name}`,
            value: s.name,
            description:
              s.name === 'create-skill'
                ? 'built-in: scaffolds new skills (/create-skill)'
                : s.description.split('\n')[0].slice(0, 80),
          })),
          selectedIndex: 0,
        },
      });
    }
    for (const w of result.warnings) addSystemLog(`Skill warning: ${w.message}`);
  } catch (err: any) {
    addErrorLog(`Failed to list skills: ${err.message}`);
  }
  return true;
}

/** `/create-skill [--global|--project] [--name <n>] <description>`. */
export async function createSkillCommand(
  parts: string[],
  agent: Agent,
  submitMessage: (text: string, displayText?: string) => void,
  addSystemLog: (content: string) => void,
  addErrorLog: (content: string) => void,
): Promise<boolean> {
  const args = parts.slice(1);
  const useGlobal = args.includes('--global');
  const useProject = args.includes('--project');
  let skillName = '';
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      skillName = args[++i];
    } else if (!args[i].startsWith('--')) {
      rest.push(args[i]);
    }
  }
  const description = rest.join(' ').trim();
  if (!description) {
    addErrorLog('Usage: /create-skill [--global|--project] [--name <n>] <description>');
    return true;
  }
  if (!skillName) {
    skillName = description
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 4)
      .join('-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName) || skillName.length > 64) {
    addErrorLog(`Invalid skill name "${skillName}". Use lowercase a-z, 0-9 and single hyphens (1-64 chars).`);
    return true;
  }
  const os = await import('node:os');
  const path = await import('node:path');
  const trusted = agent.getConfig().skillsOptions?.trusted ?? false;
  const locationDir = useGlobal
    ? path.join(os.homedir(), '.tiny-cli', 'agent', 'skills')
    : useProject || trusted
      ? path.join(process.cwd(), '.tiny-cli', 'skills')
      : path.join(os.homedir(), '.tiny-cli', 'agent', 'skills');
  submitMessage(
    `Use the create-skill skill to create a skill named "${skillName}" with description "${description}" in ${locationDir}.`
  );
  addSystemLog(`Asking the agent to scaffold skill "${skillName}" in ${locationDir}…`);
  return true;
}
