import { ToolDefinition } from '../types.js';

export type ToolContext = {
  sessionId?: string;
  cwd?: string;
};

export type ToolHandler = (args: any, context?: ToolContext) => Promise<string>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  register(definition: ToolDefinition, handler: ToolHandler) {
    this.tools.set(definition.name, { definition, handler });
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  async call(name: string, args: any, context?: ToolContext): Promise<string> {
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
