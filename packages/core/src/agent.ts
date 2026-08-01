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
import {
  MutationGate,
  MutexMap,
  classifyLockKey,
  toolLabel,
  computeMaxConcurrency,
  BASH_LOCK,
  MCP_LOCK,
} from "./concurrency.js";

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
        console.log(
          `[Agent] Executing ${response.tool_calls.length} tool call(s) in parallel ` +
          `(independent calls run concurrently; conflicting calls serialize)...`
        );

        // The tool calls returned by the model in this batch, in order.
        const toolCalls = response.tool_calls;

        // ----------------------------------------------------------------
        // PHASE 0 — Snapshot the dedupe baseline from `steps` as it exists
        // before this batch. Redundancy is decided against pre-batch
        // history plus a within-batch set (blocking duplicate same-batch
        // calls, matching the previous sequential behavior).
        // ----------------------------------------------------------------
        const preBatchKeys = new Set(
          steps
            .filter(s => s.toolCall)
            .map(s => `${s.toolCall!.function.name}:${s.toolCall!.function.arguments}`)
        );
        const seenInBatch = new Set<string>();

        type PlanKind = "EXEC" | "DENIED" | "REDUNDANT";
        interface PlanEntry {
          index: number;
          call: ToolCall;
          kind: PlanKind;
          lockKey?: string | null;
        }
        const plan: PlanEntry[] = [];

        // ----------------------------------------------------------------
        // PHASE 1 — Gating pass: sequential, in index order.
        // Redundancy + interactive permission prompts run one at a time.
        // We re-read permissionMode each iteration so an "Approve (Session)"
        // choice flips the rest of this batch to auto-run.
        // ----------------------------------------------------------------
        for (let i = 0; i < toolCalls.length; i++) {
          if (signal?.aborted) break;
          const call = toolCalls[i];
          const callKey = `${call.function.name}:${call.function.arguments}`;

          // Redundancy: block exact duplicates seen before or within this batch.
          if (preBatchKeys.has(callKey) || seenInBatch.has(callKey)) {
            console.log(`[Agent] Redundancy detected for ${callKey}. Blocking call.`);
            plan.push({ index: i, call, kind: "REDUNDANT" });
            continue;
          }
          seenInBatch.add(callKey);

          // Permission check.
          let denied = false;
          const permMode = this.config.permissionMode || "notify";
          if (onApproval && permMode !== "auto") {
            const def = toolDefinitions.find(d => d.name === call.function.name);
            let needsApproval = false;
            if (permMode === "notify") {
              needsApproval = true;
            } else if (permMode === "auto-edit") {
              // In auto-edit, we only ask for non-edit modifying tools (like bash)
              if (def?.isModifying && call.function.name === "bash") {
                needsApproval = true;
              }
            }
            if (needsApproval) {
              const approved = await onApproval(call);
              if (!approved) denied = true;
            }
          }

          if (denied) {
            plan.push({ index: i, call, kind: "DENIED" });
          } else {
            let parsedArgs: any = {};
            try {
              parsedArgs = JSON.parse(call.function.arguments);
            } catch {
              parsedArgs = {};
            }
            const lockKey = classifyLockKey(call.function.name, parsedArgs, {
              sessionId: this.config.sessionId,
              cwd: process.cwd(),
            });
            plan.push({ index: i, call, kind: "EXEC", lockKey });
          }
        }

        // ----------------------------------------------------------------
        // PHASE 2 — Concurrent execution of approved, non-redundant calls.
        // Calls touching the same resource (same file, bash, mcp, the shared
        // task file) serialize via a per-key mutex; everything else runs in
        // parallel. Results are gathered with allSettled so one rejection
        // can't discard the others.
        // ----------------------------------------------------------------
        interface ExecResult {
          result: string;
          toolCallMs: number;
          aborted: boolean;
        }

        const gate = new MutationGate();
        const pathMutex = new MutexMap();
        const execContext = { sessionId: this.config.sessionId, cwd: process.cwd() };

        // Execution windows [startMs, endMs] per entry index, used to report
        // observed concurrency for this batch.
        const execWindows: Array<{ index: number; start: number; end: number; name: string }> = [];

        /** Run a single tool call (no locking). Always resolves, capturing
         *  errors as a Tool Error string. */
        const runOne = async (
          entry: PlanEntry,
          ctx: { sessionId?: string; cwd: string },
          sig?: AbortSignal
        ): Promise<ExecResult> => {
          const label = toolLabel(entry.call);
          const t0 = performance.now();
          console.log(`[Agent] ▶ start ${label}`);
          let result: string;
          try {
            let parsedArgs: any = {};
            try {
              parsedArgs = JSON.parse(entry.call.function.arguments);
            } catch {
              parsedArgs = {};
            }
            if (entry.call.function.name.startsWith("mcp__")) {
              result = await this.mcpManager.callTool(entry.call.function.name, parsedArgs);
            } else {
              result = await this.registry.call(entry.call.function.name, parsedArgs, ctx);
            }
          } catch (error: any) {
            result = `Tool Error: ${error.message}`;
            console.error(`[Agent] Tool execution failed: ${error.message}`);
          }
          const toolCallMs = performance.now() - t0;
          execWindows.push({ index: entry.index, start: t0, end: t0 + toolCallMs, name: entry.call.function.name });
          console.log(`[Agent] ✔ done ${label} [${Math.round(toolCallMs)}ms]`);
          return {
            result,
            toolCallMs,
            aborted: !!sig?.aborted,
          };
        };

        const runExec = async (entry: PlanEntry): Promise<ExecResult> => {
          // Read-only tools (lockKey null) bypass all coordination.
          if (entry.lockKey === null) {
            return runOne(entry, execContext, signal);
          }
          const globalMutating =
            entry.lockKey === BASH_LOCK || entry.lockKey === MCP_LOCK;
          // Global mutating tools (bash/mcp) take the gate exclusively so no
          // other mutation runs concurrently. File-mutating tools take it
          // shared, and additionally serialize against same-path writes.
          const releaseGate = globalMutating
            ? await gate.acquireExclusive()
            : await gate.acquireShared();
          let releasePath: (() => void) | undefined;
          try {
            if (!globalMutating && entry.lockKey) {
              releasePath = await pathMutex.acquire(entry.lockKey);
            }
            if (signal?.aborted) {
              return { result: "", toolCallMs: 0, aborted: true };
            }
            return runOne(entry, execContext, signal);
          } finally {
            releasePath?.();
            releaseGate();
          }
        };

        // Dispatch EXEC entries; DENIED/REDUNDANT are resolved synchronously.
        const execEntries = plan.filter(p => p.kind === "EXEC");
        const batchStart = performance.now();
        const settled = await Promise.allSettled(execEntries.map(e => runExec(e)));
        const batchWallMs = performance.now() - batchStart;

        // Report observed concurrency for this batch: wall-clock vs the sum of
        // individual tool times, and the max number of tools whose execution
        // windows overlapped. If wall-clock ≈ sum and max concurrency == 1,
        // the batch ran sequentially (all calls conflicted); if max
        // concurrency > 1, they ran in parallel.
        if (execEntries.length > 0) {
          const sumMs = execWindows.reduce((acc, w) => acc + (w.end - w.start), 0);
          const maxConcurrency = computeMaxConcurrency(execWindows);
          console.log(
            `[Agent] Batch done: ${execEntries.length} tools, ` +
            `max concurrency ${maxConcurrency}, ` +
            `wall-clock ${Math.round(batchWallMs)}ms ` +
            `(sum of tools ${Math.round(sumMs)}ms` +
            `${sumMs > 0 ? `, ${Math.round((batchWallMs / sumMs) * 100)}% of sum` : ""})`
          );
        }

        // Collect all results into a sparse array indexed by original position.
        const results: Record<number, ExecResult> = {};
        execEntries.forEach((entry, n) => {
          const s = settled[n];
          if (s && s.status === "fulfilled") {
            results[entry.index] = s.value;
          } else if (s && s.status === "rejected") {
            const reason = (s as PromiseRejectedResult).reason;
            const msg = reason?.message ?? String(reason);
            results[entry.index] = {
              result: `Tool Error: ${msg}`,
              toolCallMs: 0,
              aborted: !!signal?.aborted,
            };
            console.error(`[Agent] Tool execution failed: ${msg}`);
          }
        });

        // ----------------------------------------------------------------
        // PHASE 3 — Commit in original index order.
        // Tool messages must be appended in tool_calls order so each
        // tool_call_id pairs correctly with the assistant message.
        // ----------------------------------------------------------------
        const DENIED_MSG = "Error: User denied permission to execute this tool.";
        const REDUNDANCY_MSG = (call: ToolCall) =>
          `Error: You already called ${call.function.name} with these exact arguments in this turn. The result is already in your history. Please review the previous output or change your parameters (e.g., provide different line ranges for 'read' or a different pattern for 'grep').`;

        // If aborted, commit everything up to and including the first aborted
        // index, then return the cancel response.
        const abortedIndices = Object.keys(results)
          .map(Number)
          .filter(i => results[i].aborted);
        const wasAborted = !!signal?.aborted || abortedIndices.length > 0;
        // Cut point: lowest aborted index + 1 (commit up to and including it),
        // clamped to the batch size. If aborted but no entry flagged (e.g.
        // signal fired between gating and execution), commit the whole batch
        // without a per-entry abort marker.
        let commitUpTo = toolCalls.length; // exclusive bound
        let abortMarkerIndex = -1;
        if (wasAborted && abortedIndices.length) {
          abortMarkerIndex = Math.min(...abortedIndices);
          commitUpTo = Math.min(abortMarkerIndex + 1, toolCalls.length);
        }

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

          if (onStep) onStep(step);
          steps.push(step);
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
          return { content: "Execution cancelled by user.", steps };
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
    const compactionThreshold = this.config.compactionThresholdTokens ?? 35000;
    const stats = this.getContextStats();
    if (stats.tokens <= compactionThreshold) {
      return;
    }

    console.log(`\n[Agent] Context size (${stats.tokens} tokens) exceeds ${compactionThreshold.toLocaleString()}. Compacting memory...`);

    const systemMessages = this.messages.filter(m => m.role === 'system');
    const nonSystemMessages = this.messages.filter(m => m.role !== 'system');

    const encoder = getEncoding("cl100k_base");

    let retainedTokens = 0;
    const targetRetainedTokens = this.config.compactionRetainTokens ?? 8000;
    
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
