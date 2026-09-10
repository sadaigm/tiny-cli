import { ToolDefinition } from '../types.js';
import type { AskUserPayload, AskUserResponse } from '../types.js';

export type ToolContext = {
  sessionId?: string;
  cwd?: string;
  /** Workspace boundary enforcement (config securedMode; undefined = on). */
  securedMode?: boolean;
  /** Interactive question channel (wired by Agent.run when the host provides onAskUser). */
  askUser?: (payload: AskUserPayload) => Promise<AskUserResponse>;
};

export type ToolHandler = (args: any, context?: ToolContext) => Promise<string>;

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

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
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
