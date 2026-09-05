import { ToolRegistry } from './registry.js';
import { register as registerBash } from './defs/bash.js';
import { register as registerRead } from './defs/read.js';
import { register as registerEdit } from './defs/edit.js';
import { register as registerCreateSkill } from './defs/createSkill.js';
import { register as registerList } from './defs/list.js';
import { register as registerGrep } from './defs/grep.js';
import { register as registerGlob } from './defs/glob.js';
import { register as registerPlanWrite } from './defs/planWrite.js';
import { register as registerTasks } from './defs/tasks.js';
import { register as registerMemory } from './defs/memory.js';
import { register as registerAskUser } from './defs/askUser.js';

export { buildGrepArgs } from './defs/grep.js';

/**
 * Register every built-in tool on the registry. Each tool's definition and
 * handler live in `defs/<tool>.ts` (one concern per file); this facade keeps
 * the historical `tools/definitions.js` import path stable.
 */
export function registerDefaultTools(registry: ToolRegistry) {
  registerBash(registry);
  registerRead(registry);
  registerEdit(registry); // search_replace + insert_lines + write
  registerCreateSkill(registry);
  registerList(registry);
  registerGrep(registry);
  registerGlob(registry);
  registerPlanWrite(registry);
  registerTasks(registry); // manage_tasks + mark_task_complete
  registerMemory(registry);
  registerAskUser(registry);
}
