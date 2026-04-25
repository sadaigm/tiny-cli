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

  async run(
    userInput: string,
    onStep?: (step: AgentStep) => void,
  ): Promise<AgentResponse> {
    this.messages = [];

    let systemPrompt = DEFAULT_SYSTEM_PROMPT;

    // Replace template variables
    systemPrompt = systemPrompt
      .replace("${process.cwd()}", process.cwd())
      .replace("${process.platform()}", process.platform);

    // Mandatory instruction for tool usage discipline
    systemPrompt +=
      "\n\nOnly use tools when required to perform a specific task. If the user provides a general reply or greeting, respond directly with normal text instead of using a tool call.";

    this.messages.push({ role: "system", content: systemPrompt });
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

      const response = await this.model.chat(
        this.messages,
        shouldSendTools ? this.registry.getDefinitions() : undefined,
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
}
