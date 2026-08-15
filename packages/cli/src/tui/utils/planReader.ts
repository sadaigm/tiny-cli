/**
 * Utilities for reading and modifying the active plan's task file
 * (`current_task.md`) during plan execution.
 *
 * The plan directory layout is:
 *
 * ```
 * .tiny-cli/<sessionId>/plan/
 *   ├── plan.md            — high-level design document
 *   └── current_task.md    — strict markdown checklist of tasks
 * ```
 *
 * During plan execution we iterate over incomplete tasks (`- [ ]`),
 * run each through the agent, and verify it was marked complete
 * (`- [x]`) after the turn.
 */
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Build the plan directory path for the given session.
 */
function planDir(sessionId: string): string {
  return path.join(process.cwd(), '.tiny-cli', sessionId, 'plan');
}

/**
 * Read the full contents of `current_task.md`.
 *
 * @returns The file contents, or an empty string if the file does not exist.
 */
export async function readPlanTaskFile(sessionId: string): Promise<string> {
  const taskPath = path.join(planDir(sessionId), 'current_task.md');
  try {
    return await fs.readFile(taskPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Overwrite `current_task.md` with new contents.
 */
export async function writePlanTaskFile(sessionId: string, content: string): Promise<void> {
  const taskPath = path.join(planDir(sessionId), 'current_task.md');
  await fs.writeFile(taskPath, content, 'utf-8');
}

/**
 * Read the full contents of `plan.md`.
 *
 * @returns The file contents, or an empty string if the file does not exist.
 */
export async function readPlanFile(sessionId: string): Promise<string> {
  const planPath = path.join(planDir(sessionId), 'plan.md');
  try {
    return await fs.readFile(planPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * A single incomplete task line parsed from `current_task.md`.
 */
export interface PlanTask {
  /** Zero-based index of the line in the file. */
  lineIndex: number;
  /** The raw task text including the `- [ ]` prefix. */
  raw: string;
  /** The task text without the checkbox prefix. */
  text: string;
}

/**
 * Parse incomplete tasks (`- [ ] …`) from the task file content.
 *
 * Lines matching `/^\s*- \[ \]/` are considered incomplete.
 *
 * @param content The full text of `current_task.md`.
 * @returns Ordered list of incomplete tasks.
 */
export function parseIncompleteTasks(content: string): PlanTask[] {
  const lines = content.split('\n');
  const tasks: PlanTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const match = trimmed.match(/^- \[\s\]/);
    if (match) {
      tasks.push({
        lineIndex: i,
        raw: trimmed,
        text: trimmed.replace(/^- \[\s\]\s*/, ''),
      });
    }
  }
  return tasks;
}

/**
 * Check whether a specific task line has been marked as complete (`- [x]`)
 * in the given file content.
 *
 * @param content The full text of `current_task.md`.
 * @param taskText The task text (without checkbox prefix) to search for.
 * @returns `true` if the line exists and contains `[x]`.
 */
export function isTaskMarkedComplete(content: string, taskText: string): boolean {
  const lines = content.split('\n');
  return lines.some(
    (line) => line.includes(taskText) && line.includes('[x]'),
  );
}

/**
 * Manually mark a task as complete in the file content by replacing
 * its `- [ ]` with `- [x]`.
 *
 * @param content The full text of `current_task.md`.
 * @param taskText The task text (without checkbox prefix) to match.
 * @returns The modified file content.
 */
export function markTaskCompleteInContent(content: string, taskText: string): string {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(taskText) && lines[i].match(/^- \[\s\]/)) {
      lines[i] = lines[i].replace(/^- \[\s\]/, '- [x]');
    }
  }
  return lines.join('\n');
}
