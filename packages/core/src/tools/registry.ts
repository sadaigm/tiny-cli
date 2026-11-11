import { ToolDefinition, ExecTarget } from '../types.js';
import type { AskUserPayload, AskUserResponse } from '../types.js';

export type ToolContext = {
  sessionId?: string;
  cwd?: string;
  /** Workspace boundary enforcement (config securedMode; undefined = on). */
  securedMode?: boolean;
  /** Execution target for bash (docker container / ssh host); unset = local. File tools map paths through its `root`. */
  execTarget?: ExecTarget;
  /** Active profile name (used in exec-target block messages). */
  profileName?: string;
  /** Interactive question channel (wired by Agent.run when the host provides onAskUser). */
  askUser?: (payload: AskUserPayload) => Promise<AskUserResponse>;
};

export type ToolHandler = (args: any, context?: ToolContext) => Promise<string>;

/**
 * Built-in tools that read/write files on the host filesystem. When an exec
 * target is a container with no resolvable host mapping (bash-only profile),
 * these cannot reach the container's files and are stripped from the tool list
 * sent to the model — bash remains the only way to touch container files.
 */
export const FILE_TOOLS = [
  'read',
  'search_replace',
  'insert_lines',
  'write',
  'create_skill',
  'list',
  'grep',
  'glob',
  'plan_write',
  'manage_tasks',
  'memory',
] as const;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  /** Per-tool call counts for this process (see Agent.getToolUsageStats). */
  private usage = new Map<string, number>();

  register(definition: ToolDefinition, handler: ToolHandler) {
    this.tools.set(definition.name, { definition, handler });
  }

  /**
   * Built-in tool definitions, optionally excluding the file tools. Pass
   * `excludeFileTools: true` for a container exec target with no host mapping
   * (bash-only profile) so the model can't be offered tools that can't reach
   * the container's files.
   */
  getDefinitions(options?: { excludeFileTools?: boolean }): ToolDefinition[] {
    const all = Array.from(this.tools.values()).map(t => t.definition);
    if (!options?.excludeFileTools) return all;
    return all.filter(d => !(FILE_TOOLS as readonly string[]).includes(d.name));
  }

  getUsageStats(): Record<string, number> {
    return Object.fromEntries([...this.usage.entries()].sort((a, b) => b[1] - a[1]));
  }

  async call(name: string, args: any, context?: ToolContext): Promise<string> {
    this.usage.set(name, (this.usage.get(name) || 0) + 1);
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }
    try {
      return await tool.handler(args, context);
    } catch (error: any) {
      return `Error calling tool "${name}": ${error.message}`;
    }
  }
}
