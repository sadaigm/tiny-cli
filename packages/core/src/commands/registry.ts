import { ToolDefinition } from '../types.js';

export interface CommandDefinition {
  name: string;
  description: string;
  hasSubOptions?: boolean;
  handler?: (args?: string) => Promise<void>;
}

export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();

  register(command: CommandDefinition) {
    this.commands.set(command.name, command);
  }

  getCommand(name: string): CommandDefinition | undefined {
    return this.commands.get(name.startsWith('/') ? name.slice(1) : name);
  }

  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  clear() {
    this.commands.clear();
  }
}
