import {
  AgentConfig,
  Message,
  ToolResult,
  AgentResponse,
  AgentStep,
  ToolCall,
  AskUserPayload,
  AskUserResponse,
  ToolDefinition,
} from "./types.js";
import { ModelClient } from "./model/client.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerDefaultTools } from "./tools/definitions.js";
import { getRedirectCounts } from "./tools/bashRedirect.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts/default.js";
import { AGENT_SYSTEM_PROMPT } from "./prompts/agent.js";
import { PLANNING_SYSTEM_PROMPT } from "./prompts/planning.js";
import fs from "fs/promises";
import path from "path";
import { McpManager } from "./mcp/manager.js";

// Helper functions for memory relevance filtering
function filterRelevantMemories(userInput: string, memories: Array<{type: string, description: string, content: string}>): Array<{type: string, description: string, content: string}> {
  const keywords = extractKeywords(userInput.toLowerCase());

  return memories.filter(m => {
    // Always include user preferences (small, high-value)
    if (m.type === 'user') return true;

    // Keyword match for other types
    const memoryText = (m.description + ' ' + m.content).toLowerCase();
    return keywords.some(k => memoryText.includes(k));
  });
}

// Simple keyword extraction (v1)
function extractKeywords(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'this', 'that', 'is', 'are', 'was', 'were']);
  const words = text.split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
  return [...new Set(words)];
}
import { loadSkills, renderSkillsXml } from "@tiny-cli/resources";
import { logDebug } from "./logger.js";
import {
  TOOL_CALLS_PER_COMPACT_CHECK,
  measureContext,
} from "./compact_utils.js";
import { extractTextToolCalls } from "./agent/textToolCalls.js";
import { compactMemory } from "./agent/compaction.js";
import {
  executeToolBatch,
  DENIED_MSG,
  REDUNDANCY_MSG,
} from "./agent/toolExecution.js";

export class Agent {
  private model: ModelClient;
  private registry: ToolRegistry;
  private config: AgentConfig;
  private messages: Message[] = [];
  public mcpManager: McpManager;

  /** Called after any message is appended to this.messages. */
  onHistoryChange?: () => void;
  /** Called when a compaction actually runs (before/after token counts). */
  onCompaction?: (before: number, after: number) => void;
  /** Called when a model request fails mid-turn; the turn continues. */
  onModelError?: (error: Error) => void;

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
    onApproval?: (call: ToolCall) => Promise<boolean>,
    onText?: (delta: string) => void,
    onReasoning?: (delta: string) => void,
    onAskUser?: (payload: AskUserPayload) => Promise<AskUserResponse>
  ): Promise<AgentResponse> {
    if (!continueSession) {
      this.messages = [];
    }

    // Always ensure the system prompt matches the current mode and plan state.
    // Keep compaction summaries ([PREVIOUS CONTEXT SUMMARY]) — they carry the
    // compacted context across turns and session reloads; only the mode
    // system prompt is replaced.
    this.messages = this.messages.filter(
      (m) => m.role !== 'system' || m.content.startsWith('[PREVIOUS CONTEXT SUMMARY]')
    );

    let systemPrompt: string;
    if (mode === 'plan') {
      systemPrompt = this.config.prompts?.plan ?? PLANNING_SYSTEM_PROMPT;
    } else if (mode === 'chat') {
      systemPrompt = this.config.prompts?.chat ?? DEFAULT_SYSTEM_PROMPT;
    } else {
      systemPrompt = this.config.prompts?.agent ?? AGENT_SYSTEM_PROMPT;
    }

    // Replace template variables
    systemPrompt = systemPrompt
      .replace("${process.cwd()}", process.cwd())
      .replace("${process.platform()}", process.platform);

    // Inject available agent skills into the system prompt (re-derived each run)
    const skillsResult = await loadSkills(
      this.config.skillsOptions ?? { settingsSkills: [], cliSkills: [], noSkills: false, trusted: false }
    );
    for (const w of skillsResult.warnings) logDebug(w.message);
    const skillsXml = renderSkillsXml(skillsResult.skills);
    if (skillsXml) systemPrompt += `\n\n${skillsXml}`;

    // Active skills (selected via /skills): inject the full body so the
    // procedure is always in context. Re-derived each run, so it survives
    // compaction and session reloads.
    const activeNames = this.config.activeSkills ?? [];
    if (activeNames.length > 0) {
      const activeBlocks: string[] = [];
      for (const name of activeNames) {
        const skill = skillsResult.skills.find((s) => s.name === name);
        if (!skill) continue;
        try {
          const body = await fs.readFile(skill.path, 'utf-8');
          activeBlocks.push(
            `<active_skill name="${name}">\n${body}\n</active_skill>`
          );
        } catch {
          // Skill file unreadable — skip silently; metadata listing above still applies.
        }
      }
      if (activeBlocks.length > 0) {
        systemPrompt += `\n\n<active_skills>\n${activeBlocks.join('\n')}\n</active_skills>`;
      }
    }

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

    // Inject project instructions (CLAUDE.md / AGENTS.md) if present
    const { loadInstructions } = await import('./instructions.js');
    const instructions = await loadInstructions(process.cwd());
    if (instructions.length > 0) {
      const blocks = instructions.map(
        (b) => `<project_instructions source="${b.source}">\n${b.content}\n</project_instructions>`
      );
      systemPrompt += `\n\n${blocks.join('\n')}`;
    }

    // Inject project memory if present (with relevance filtering to control token cost)
    const memoryIndexPath = path.join(process.cwd(), '.tiny-cli/memory/MEMORY.md');
    try {
      const indexContent = await fs.readFile(memoryIndexPath, 'utf-8');
      const memoryLines = indexContent.split('\n').filter(line => line.startsWith('- ['));

      if (memoryLines.length > 0) {
        // Load all memories first
        const allMemories: Array<{name: string, description: string, type: string, content: string}> = [];
        for (const line of memoryLines) {
          const match = line.match(/\]\(([^)]+)\)/);
          if (match) {
            const memoryFile = path.join(process.cwd(), '.tiny-cli/memory', match[1]);
            try {
              const memoryContent = await fs.readFile(memoryFile, 'utf-8');

              // Parse frontmatter to get type and description
              const frontmatterMatch = memoryContent.match(/^---\nname: (.+)\ndescription: (.+)\nmetadata:\n  type: (.+)\n---\n/);
              if (frontmatterMatch) {
                allMemories.push({
                  name: frontmatterMatch[1],
                  description: frontmatterMatch[2],
                  type: frontmatterMatch[3],
                  content: memoryContent
                });
              }
            } catch {
              // Individual file unreadable — skip silently
            }
          }
        }

        // Filter by relevance (keyword matching + type priority)
        const relevantMemories = filterRelevantMemories(userInput, allMemories);

        // Apply size limit (fallback to prevent bloat)
        const MAX_MEMORY_CHARS = 10_000;
        let memoryContent = relevantMemories.map(m => m.content).join('\n---\n');

        if (memoryContent.length > MAX_MEMORY_CHARS) {
          // Keep newest within limit
          const truncated = memoryContent.slice(-MAX_MEMORY_CHARS);
          memoryContent = `\n[...some relevant memories truncated to fit limit...]\n${truncated}`;
        }

        if (memoryContent) {
          systemPrompt += `\n\n<project_memory>\n${memoryContent}\n</project_memory>`;
        }
      }
    } catch {
      // No memory directory — ignore silently
    }

    this.messages.unshift({ role: "system", content: systemPrompt });

    // Turn-start compaction: check before the new user message is appended,
    // so the fresh query is never summarized away. No-op under threshold.
    await this.compactMemoryIfNeeded(signal);

    this.messages.push({ role: "user", content: userInput });
    this.onHistoryChange?.();

    const steps: AgentStep[] = [];
    let toolCallCount = 0;
    let iteration = 0;
    const maxIterations = this.config.maxIterations || 25;
    let consecutiveModelErrors = 0;

    while (iteration < maxIterations) {
      if (signal?.aborted) {
        logDebug('[trace] agent.run: signal aborted at loop top — returning cancellation');
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
          signal,
          onText,
          onReasoning
        );
      } catch (error: any) {
        logDebug(`[trace] agent.run model call threw: name=${error?.name} message=${error?.message} aborted=${signal?.aborted}`);
        if (signal?.aborted) {
          return { content: "Execution cancelled by user.", steps };
        }
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          // Fetch aborted but not by the user → request timeout.
          return { content: `Request timed out after ${((this.config.requestTimeoutMs ?? 120_000) / 1000).toFixed(0)}s. Increase requestTimeoutMs in config or use a faster model.`, steps };
        }
        // Surface the failure to the user and keep the turn alive — the
        // next iteration re-attempts the request (covers transient provider
        // errors). Give up once failures repeat consecutively so a
        // persistently broken request can't loop forever.
        consecutiveModelErrors++;
        this.onModelError?.(error);
        logDebug(`Model request failed (attempt ${consecutiveModelErrors}): ${error.message}`);
        if (consecutiveModelErrors >= 3) throw error;
        continue;
      }
      consecutiveModelErrors = 0;
      const modelChatMs = performance.now() - modelStart;

      // Opt-in fallback: some small local models emit tool calls as text JSON
      // instead of native tool_calls. Promote them to real tool calls so they
      // execute; only active when settings.textToolCallFallback is true.
      if (
        this.config.textToolCallFallback === true &&
        (!response.tool_calls || response.tool_calls.length === 0) &&
        response.content
      ) {
        const textCalls = extractTextToolCalls(response.content, toolDefinitions);
        if (textCalls.length > 0) {
          logDebug(`textToolCallFallback: extracted ${textCalls.length} tool call(s) from response text`);
          response.tool_calls = textCalls;
          response.content = '';
        }
      }

      this.messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });
      this.onHistoryChange?.();

      // A streamed turn with no tool calls is final — the caller has
      // already seen every delta, so don't re-emit the full text.
      if (
        onText &&
        (!response.tool_calls || response.tool_calls.length === 0) &&
        response.content
      ) {
        (response as { streamedFinal?: boolean }).streamedFinal = true;
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        logDebug(
          `Executing ${response.tool_calls.length} tool call(s) in parallel ` +
          `(independent calls run concurrently; conflicting calls serialize)...`
        );

        // The tool calls returned by the model in this batch, in order.
        const toolCalls = response.tool_calls;

        // PHASE 0-2 (dedupe gating + concurrent execution) and the PHASE 3
        // cut-point calculation live in agent/toolExecution.ts.
        const { plan, results, wasAborted, commitUpTo, abortMarkerIndex } = await executeToolBatch({
          toolCalls,
          steps,
          toolDefinitions,
          config: this.config,
          registry: this.registry,
          mcpManager: this.mcpManager,
          signal,
          onApproval,
          onAskUser,
        });

        // ----------------------------------------------------------------
        // PHASE 3 — Commit in original index order.
        // Tool messages must be appended in tool_calls order so each
        // tool_call_id pairs correctly with the assistant message.
        // ----------------------------------------------------------------

        for (let i = 0; i < commitUpTo; i++) {
          const entry = plan[i];
          const call = entry.call;
          let result: string;
          let toolCallMs: number | undefined;

          if (entry.kind === "EXEC") {
            const r = results[i];
            result = r.result;
            toolCallMs = r.toolCallMs;
            if (i === abortMarkerIndex) {
              // Append the abort marker on the entry at the cut point.
              result = result + "\n\n[Execution aborted by user]";
            }
          } else if (entry.kind === "DENIED") {
            result = DENIED_MSG;
          } else {
            result = REDUNDANCY_MSG(call);
          }

          const step: AgentStep = {
            thought: response.content,
            toolCall: call,
            toolResult: result,
            timing: { modelChatMs, toolCallMs },
          };

          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
          toolCallCount++;

          if (onStep) onStep(step);
          steps.push(step);
        }
        this.onHistoryChange?.();

        // Mid-turn safety valve: compact at a complete tool-round boundary
        // every TOOL_CALLS_PER_COMPACT_CHECK tool calls, so a long agentic
        // turn can't blow far past the threshold.
        if (toolCallCount % TOOL_CALLS_PER_COMPACT_CHECK === 0) {
          await this.compactMemoryIfNeeded(signal);
        }

        if (wasAborted) {
          // On abort we return immediately, but the assistant message above
          // already references every tool_call_id. Append tool messages for any
          // tail entries that still ran (with a cancellation note) so the
          // persisted history stays well-formed for the next run.
          for (let i = commitUpTo; i < toolCalls.length; i++) {
            const entry = plan[i];
            let result: string;
            if (entry.kind === "EXEC" && results[i]) {
              result = results[i].result + "\n\n[Execution aborted by user]";
            } else if (entry.kind === "DENIED") {
              result = DENIED_MSG;
            } else {
              result = REDUNDANCY_MSG(entry.call);
            }
            this.messages.push({
              role: "tool",
              tool_call_id: entry.call.id,
              content: result,
            });
          }
          this.onHistoryChange?.();
          return { content: "Execution cancelled by user.", steps };
        }
      } else {
        // No more tool calls, agent is done
        await this.compactMemoryIfNeeded(signal);
        return {
          content: response.content,
          steps,
          // Marks a turn whose text was already delivered incrementally —
          // the UI checks this to avoid re-appending the full blob.
          streamedFinal: (response as { streamedFinal?: boolean }).streamedFinal === true,
        } as AgentResponse;
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

  /** Per-process tool call counts + how often bash commands were redirected
   *  to dedicated tools (see tools/bashRedirect.ts). */
  getToolUsageStats(): { tools: Record<string, number>; redirects: Record<string, number> } {
    return { tools: this.registry.getUsageStats(), redirects: getRedirectCounts() };
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
    return measureContext(this.messages);
  }

  /**
   * Force a memory compaction now, ignoring the configured threshold.
   *
   * Summarises the oldest history into a single `[PREVIOUS CONTEXT
   * SUMMARY]` system message, keeping the most recent retained tokens
   * verbatim. Returns the new context size in tokens, or null when there
   * was nothing to summarise (all history already fits the retention
   * budget). Exposed so the TUI's `/compact` command can trigger it on
   * demand.
   */
  async compactNow(signal?: AbortSignal): Promise<number | null> {
    return this.compactMemoryIfNeeded(signal, true);
  }

  private async compactMemoryIfNeeded(signal?: AbortSignal, force = false): Promise<number | null> {
    // Threshold-gated compaction lives in agent/compaction.ts; this delegate
    // applies the rebuilt history and fires the history/compaction events.
    const result = await compactMemory({
      messages: this.messages,
      config: this.config,
      model: this.model,
      signal,
      force,
    });
    if (!result) return null;
    this.messages = result.history;
    this.onCompaction?.(result.before, result.after);
    this.onHistoryChange?.();
    return result.after;
  }
}
