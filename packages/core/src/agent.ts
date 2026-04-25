import {
  AgentConfig,
  Message,
  ToolResult,
  AgentResponse,
  AgentStep,
} from "./types.js";
import { ModelClient } from "./model/client.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerDefaultTools } from "./tools/definitions.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts/default.js";
import { PLANNING_SYSTEM_PROMPT } from "./prompts/planning.js";
import { getEncoding, type Tiktoken } from "js-tiktoken";

export class Agent {
  private model: ModelClient;
  private registry: ToolRegistry;
  private config: AgentConfig;
  private messages: Message[] = [];

  constructor(config: AgentConfig) {
    this.config = config;
    this.model = new ModelClient(config);
    this.registry = new ToolRegistry();
    registerDefaultTools(this.registry);
  }

  setHistory(messages: Message[]) {
    this.messages = [...messages];
  }

  getHistory(): Message[] {
    return this.messages;
  }

  async run(
    userInput: string,
    onStep?: (step: AgentStep) => void,
    mode: 'chat' | 'plan' = 'chat',
    continueSession: boolean = false
  ): Promise<AgentResponse> {
    if (!continueSession || this.messages.length === 0) {
      const hasSystemPrompt = this.messages.some(m => m.role === 'system');
      
      if (!continueSession || !hasSystemPrompt) {
        if (!continueSession) {
          this.messages = [];
        }
        
        let systemPrompt = mode === 'plan' ? PLANNING_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;

        // Replace template variables
        systemPrompt = systemPrompt
          .replace("${process.cwd()}", process.cwd())
          .replace("${process.platform()}", process.platform);

        // Mandatory instruction for tool usage discipline
        if (mode === 'chat') {
          systemPrompt +=
            "\n\nOnly use tools when required to perform a specific task. If the user provides a general reply or greeting, respond directly with normal text instead of using a tool call.";
        }

        this.messages.push({ role: "system", content: systemPrompt });
      }
    }

    this.messages.push({ role: "user", content: userInput });

    const steps: AgentStep[] = [];
    let iteration = 0;
    const maxIterations = 10;

    while (iteration < maxIterations) {
      iteration++;

      // Only send tools if we're not responding to a tool result
      // (i.e., if the last message is not a 'tool' role message)
      const lastMessage = this.messages[this.messages.length - 1];
      const shouldSendTools = !lastMessage || lastMessage.role !== "tool";

      let toolDefinitions = shouldSendTools ? this.registry.getDefinitions() : undefined;
      
      // In plan mode, filter out 'write' tool
      if (mode === 'plan' && toolDefinitions) {
        toolDefinitions = toolDefinitions.filter(d => d.name !== 'write');
      }

      const response = await this.model.chat(
        this.messages,
        toolDefinitions,
      );

      this.messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          const step: AgentStep = {
            thought: response.content,
            toolCall: call,
          };

          const result = await this.registry.call(
            call.function.name,
            JSON.parse(call.function.arguments),
          );
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
        return {
          content: response.content,
          steps,
        };
      }
    }

    return {
      content: "Reached maximum iterations.",
      steps,
    };
  }

  getMessages() {
    return this.messages;
  }

  getToolDefinitions() {
    return this.registry.getDefinitions();
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
}
