import {
  AgentConfig,
  Message,
  ToolResult,
  AgentResponse,
  AgentStep,
  ToolCall,
} from "./types.js";
import { ModelClient } from "./model/client.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerDefaultTools } from "./tools/definitions.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts/default.js";
import { AGENT_SYSTEM_PROMPT } from "./prompts/agent.js";
import { PLANNING_SYSTEM_PROMPT } from "./prompts/planning.js";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import fs from "fs/promises";
import path from "path";
import { McpManager } from "./mcp/manager.js";

export class Agent {
  private model: ModelClient;
  private registry: ToolRegistry;
  private config: AgentConfig;
  private messages: Message[] = [];
  public mcpManager: McpManager;

  constructor(config: AgentConfig) {
    this.config = config;
    this.model = new ModelClient(config);
    this.registry = new ToolRegistry();
    registerDefaultTools(this.registry);
    this.mcpManager = new McpManager();
  }

  async init(): Promise<void> {
    if (this.config.mcpServers?.length) {
      this.mcpManager.connectBackground(this.config.mcpServers);
    }
  }

  async destroy(): Promise<void> {
    await this.mcpManager.close();
  }

  setSessionId(id: string) {
    this.config.sessionId = id;
  }

  getSessionId(): string | undefined {
    return this.config.sessionId;
  }

  setHistory(messages: Message[]) {
    this.messages = [...messages];
  }

  getHistory(): Message[] {
    return this.messages;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  updateConfig(updates: Partial<AgentConfig>) {
    this.config = { ...this.config, ...updates };
    // Re-initialize model client if model or endpoint changed
    if (updates.model || updates.endpoint) {
      this.model = new ModelClient(this.config);
    }
  }

  async run(
    userInput: string,
    onStep?: (step: AgentStep) => void,
    mode: 'agent' | 'chat' | 'plan' = 'agent',
    continueSession: boolean = false,
    signal?: AbortSignal,
    onApproval?: (call: ToolCall) => Promise<boolean>
  ): Promise<AgentResponse> {
    if (!continueSession) {
      this.messages = [];
    }

    // Always ensure the system prompt matches the current mode and plan state
    this.messages = this.messages.filter(m => m.role !== 'system');

    let systemPrompt: string;
    if (mode === 'plan') {
      systemPrompt = PLANNING_SYSTEM_PROMPT;
    } else if (mode === 'chat') {
      systemPrompt = DEFAULT_SYSTEM_PROMPT;
    } else {
      systemPrompt = AGENT_SYSTEM_PROMPT;
    }

    // Replace template variables
    systemPrompt = systemPrompt
      .replace("${process.cwd()}", process.cwd())
      .replace("${process.platform()}", process.platform);

    // Mandatory instruction for tool usage discipline
    if (mode === 'chat') {
      systemPrompt +=
        "\n\nOnly use tools when required to perform a specific task. If the user provides a general reply or greeting, respond directly with normal text instead of using a tool call.";
    }

    // Inject Plan Context if available
    if (mode === 'agent' && this.config.sessionId) {
      const planPath = path.join(process.cwd(), '.tiny-cli', this.config.sessionId, 'plan', 'current_task.md');
      try {
        const planContent = await fs.readFile(planPath, 'utf-8');
        systemPrompt += `\n\nCURRENT PROJECT PLAN AND TASKS:\n--------------------------------------------------\n${planContent}\n--------------------------------------------------\n
GUIDANCE FOR PLAN EXECUTION:
1. When you start or resume, review the task list above to see what's done and what's pending.
2. If the user asks to "continue", verify if the most recent task is actually complete.
3. If you find a task is completed but not marked in the list, use the \`manage_tasks\` tool with \`action: "mark_done"\` to update the list.
4. If the user provides a request that is not in the plan, you can add it to the plan using \`manage_tasks\` with \`action: "add"\`.
5. Always prioritize the next incomplete task in the plan.`;
      } catch (e) {
        // No plan found, ignore
      }
    }

    this.messages.unshift({ role: "system", content: systemPrompt });

    this.messages.push({ role: "user", content: userInput });

    const steps: AgentStep[] = [];
    let iteration = 0;
    const maxIterations = this.config.maxIterations || 25;

    while (iteration < maxIterations) {
      if (signal?.aborted) {
        return { content: "Execution cancelled by user.", steps };
      }

      iteration++;

      let toolDefinitions = [
        ...this.registry.getDefinitions(),
        ...this.mcpManager.getDefinitions()
      ];
      
      if (toolDefinitions) {
        if (mode === 'plan') {
          const allowedTools = ['read', 'list', 'grep', 'glob', 'plan_write'];
          // Keep MCP tools out of plan mode unless specifically allowed, 
          // for now we filter built-ins as before and keep all MCP tools for agent/chat
          toolDefinitions = toolDefinitions.filter(d => 
            d.name.startsWith('mcp__') || allowedTools.includes(d.name)
          );
        } else {
          toolDefinitions = toolDefinitions.filter(d => d.name !== 'plan_write');
          
          if (mode === 'chat') {
            const allowedTools = ['read', 'list', 'grep'];
            toolDefinitions = toolDefinitions.filter(d => 
              d.name.startsWith('mcp__') || allowedTools.includes(d.name)
            );
          }
        }
      }

      const modelStart = performance.now();
      let response;
      try {
        response = await this.model.chat(
          this.messages,
          toolDefinitions,
          signal
        );
      } catch (error: any) {
        if (error.name === 'AbortError' || signal?.aborted) {
          return { content: "Execution cancelled by user.", steps };
        }
        throw error;
      }
      const modelChatMs = performance.now() - modelStart;

      this.messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`[Agent] Executing ${response.tool_calls.length} tool calls...`);
        for (const call of response.tool_calls) {
          const argStr = call.function.arguments;
          const callKey = `${call.function.name}:${argStr}`;
          
          // Check for exact redundancy in this run to prevent loops
          const previousCalls = steps
            .filter(s => s.toolCall)
            .map(s => `${s.toolCall!.function.name}:${s.toolCall!.function.arguments}`);
          
          if (previousCalls.includes(callKey)) {
            console.log(`[Agent] Redundancy detected for ${callKey}. Blocking call.`);
            const redundancyError = `Error: You already called ${call.function.name} with these exact arguments in this turn. The result is already in your history. Please review the previous output or change your parameters (e.g., provide different line ranges for 'read' or a different pattern for 'grep').`;
            
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: redundancyError,
            });
            continue;
          }

          const step: AgentStep = {
            thought: response.content,
            toolCall: call,
          };

          const toolStart = performance.now();
          let result: string | null = null;

          // Permission Check
          const mode = this.config.permissionMode || 'notify';
          if (onApproval && mode !== 'auto') {
            const def = toolDefinitions.find(d => d.name === call.function.name);
            let needsApproval = false;
            if (mode === 'notify') {
              needsApproval = true;
            } else if (mode === 'auto-edit') {
              // In auto-edit, we only ask for non-edit modifying tools (like bash)
              if (def?.isModifying && call.function.name === 'bash') {
                needsApproval = true;
              }
            }
            
            if (needsApproval) {
              const approved = await onApproval(call);
              if (!approved) {
                result = "Error: User denied permission to execute this tool.";
              }
            }
          }
          
          if (result === null) {
            try {
            const parsedArgs = JSON.parse(argStr);
            if (call.function.name.startsWith('mcp__')) {
              result = await this.mcpManager.callTool(call.function.name, parsedArgs);
            } else {
              result = await this.registry.call(
                call.function.name,
                parsedArgs,
                { sessionId: this.config.sessionId, cwd: process.cwd() }
              );
            }
          } catch (error: any) {
            result = `Tool Error: ${error.message}`;
            console.error(`[Agent] Tool execution failed: ${error.message}`);
          }
        }
          const toolCallMs = performance.now() - toolStart;
          
          step.timing = { modelChatMs, toolCallMs };

          if (signal?.aborted) {
            step.toolResult = result + '\n\n[Execution aborted by user]';
            steps.push(step);
            return { content: "Execution cancelled by user.", steps };
          }

          step.toolResult = result;

          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });

          if (onStep) onStep(step);
          steps.push(step);
        }
      } else {
        // No more tool calls, agent is done
        await this.compactMemoryIfNeeded(signal);
        return {
          content: response.content,
          steps,
        };
      }
    }

    await this.compactMemoryIfNeeded(signal);
    return {
      content: "Reached maximum iterations.",
      steps,
    };
  }

  getMessages() {
    return this.messages;
  }
  getToolDefinitions(mode?: 'agent' | 'chat' | 'plan') {
    let definitions = [
      ...this.registry.getDefinitions(),
      ...this.mcpManager.getDefinitions()
    ];
    
    if (mode === 'plan') {
      const allowedTools = ['read', 'list', 'grep', 'glob', 'plan_write'];
      definitions = definitions.filter(d => d.name.startsWith('mcp__') || allowedTools.includes(d.name));
    } else {
      definitions = definitions.filter(d => d.name !== 'plan_write');
      if (mode === 'chat') {
        const allowedTools = ['read', 'list', 'grep'];
        definitions = definitions.filter(d => d.name.startsWith('mcp__') || allowedTools.includes(d.name));
      }
    }
    
    return definitions;
  }

  getContextStats() {
    const encoder = getEncoding("cl100k_base");
    let totalTokens = 0;
    let totalChars = 0;

    for (const m of this.messages) {
      if (m.content) {
        totalChars += m.content.length;
        totalTokens += encoder.encode(m.content).length;
      }
      
      if (m.tool_calls) {
        const toolCallsStr = JSON.stringify(m.tool_calls);
        totalChars += toolCallsStr.length;
        totalTokens += encoder.encode(toolCallsStr).length;
      }
    }

    return {
      tokens: totalTokens,
      characters: totalChars,
    };
  }

  private async compactMemoryIfNeeded(signal?: AbortSignal) {
    const stats = this.getContextStats();
    if (stats.tokens <= 35000) {
      return;
    }

    console.log(`\n[Agent] Context size (${stats.tokens} tokens) exceeds 35,000. Compacting memory...`);

    const systemMessages = this.messages.filter(m => m.role === 'system');
    const nonSystemMessages = this.messages.filter(m => m.role !== 'system');

    const encoder = getEncoding("cl100k_base");
    
    let retainedTokens = 0;
    const targetRetainedTokens = 8000;
    
    let retainIndex = nonSystemMessages.length;
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const m = nonSystemMessages[i];
      let msgTokens = 0;
      if (m.content) msgTokens += encoder.encode(m.content).length;
      if (m.tool_calls) msgTokens += encoder.encode(JSON.stringify(m.tool_calls)).length;
      
      if (retainedTokens + msgTokens > targetRetainedTokens) {
        break;
      }
      retainedTokens += msgTokens;
      retainIndex = i;
    }

    const messagesToSummarize = nonSystemMessages.slice(0, retainIndex);
    const messagesToRetain = nonSystemMessages.slice(retainIndex);

    if (messagesToSummarize.length === 0) {
      return;
    }

    const summaryPrompt = "Summarize the following conversation history. IDENTIFY THE CURRENT ACTIVE TASK and the state of the implementation. Preserve all key technical decisions, file paths, completed tasks, and context. Do not omit any important technical details, errors, or findings.";
    
    const summaryMessages: Message[] = [
      ...systemMessages,
      ...messagesToSummarize,
      { role: "user", content: summaryPrompt }
    ];

    try {
      const response = await this.model.chat(summaryMessages, [], signal);
      
      const summaryMessage: Message = {
        role: "system",
        content: `[PREVIOUS CONTEXT SUMMARY]\n${response.content}`
      };

      this.messages = [
        ...systemMessages,
        summaryMessage,
        ...messagesToRetain
      ];

      console.log(`[Agent] Memory compacted. New context size: ${this.getContextStats().tokens} tokens.\n`);
    } catch (err: any) {
      if (err.name === 'AbortError' || signal?.aborted) {
        // Aborted, do nothing
      } else {
        console.error(`[Agent] Memory compaction failed: ${err.message}`);
      }
    }
  }
}
