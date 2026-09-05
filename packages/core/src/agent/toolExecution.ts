import {
  AgentConfig,
  AgentStep,
  AskUserPayload,
  AskUserResponse,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { ToolRegistry } from "../tools/registry.js";
import { McpManager } from "../mcp/manager.js";
import {
  MutationGate,
  MutexMap,
  classifyLockKey,
  toolLabel,
  computeMaxConcurrency,
  BASH_LOCK,
  MCP_LOCK,
} from "../concurrency.js";
import { logDebug } from "../logger.js";

export const DENIED_MSG = "Error: User denied permission to execute this tool.";
export const REDUNDANCY_MSG = (call: ToolCall) =>
  `Error: You already called ${call.function.name} with these exact arguments in this turn. The result is already in your history. Please review the previous output or change your parameters (e.g., provide different line ranges for 'read' or a different pattern for 'grep').`;

export type PlanKind = "EXEC" | "DENIED" | "REDUNDANT";
export interface PlanEntry {
  index: number;
  call: ToolCall;
  kind: PlanKind;
  lockKey?: string | null;
}

export interface ExecResult {
  result: string;
  toolCallMs: number;
  aborted: boolean;
}

export interface ToolBatchDeps {
  /** The tool calls returned by the model in this batch, in order. */
  toolCalls: ToolCall[];
  /** Completed steps so far — the dedupe baseline (PHASE 0). */
  steps: AgentStep[];
  /** Tool definitions visible in the current mode (permission lookups). */
  toolDefinitions: ToolDefinition[];
  config: AgentConfig;
  registry: ToolRegistry;
  mcpManager: McpManager;
  signal?: AbortSignal;
  onApproval?: (call: ToolCall) => Promise<boolean>;
  onAskUser?: (payload: AskUserPayload) => Promise<AskUserResponse>;
}

export interface BatchOutcome {
  plan: PlanEntry[];
  /** Fulfilled/rejected results indexed by original tool-call position. */
  results: Record<number, ExecResult>;
  wasAborted: boolean;
  /** Exclusive commit bound (see cut-point comment in PHASE 3). */
  commitUpTo: number;
  abortMarkerIndex: number;
}

/**
 * Concurrent tool-batch execution (moved verbatim from Agent.run's PHASE 0-2,
 * plus the PHASE 3 cut-point calculation).
 *
 * PHASE 0 — snapshot the dedupe baseline from `steps`.
 * PHASE 1 — gating pass (redundancy + interactive permission), sequential.
 * PHASE 2 — concurrent execution: calls touching the same resource (same
 * file, bash, mcp, the shared task file) serialize via a per-key mutex;
 * everything else runs in parallel. Results are gathered with allSettled so
 * one rejection can't discard the others.
 *
 * Committing the results to history (PHASE 3 proper) stays with the caller —
 * it owns `messages`, `steps`, and the onStep stream.
 */
export async function executeToolBatch(deps: ToolBatchDeps): Promise<BatchOutcome> {
  const {
    toolCalls,
    steps,
    toolDefinitions,
    config,
    registry,
    mcpManager,
    signal,
    onApproval,
    onAskUser,
  } = deps;

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
      logDebug(`Redundancy detected for ${callKey}. Blocking call.`);
      plan.push({ index: i, call, kind: "REDUNDANT" });
      continue;
    }
    seenInBatch.add(callKey);

    // Permission check.
    let denied = false;
    const permMode = config.permissionMode || "notify";
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
        sessionId: config.sessionId,
        cwd: process.cwd(),
      });
      plan.push({ index: i, call, kind: "EXEC", lockKey });
    }
  }

  // ----------------------------------------------------------------
  // PHASE 2 — Concurrent execution of approved, non-redundant calls.
  // ----------------------------------------------------------------
  const gate = new MutationGate();
  const pathMutex = new MutexMap();
  const execContext = { sessionId: config.sessionId, cwd: process.cwd(), askUser: onAskUser };

  // Execution windows [start, end] per entry index, used to report
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
    logDebug(`▶ start ${label}`);
    let result: string;
    try {
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(entry.call.function.arguments);
      } catch {
        parsedArgs = {};
      }
      if (entry.call.function.name.startsWith("mcp__")) {
        result = await mcpManager.callTool(entry.call.function.name, parsedArgs);
      } else {
        result = await registry.call(entry.call.function.name, parsedArgs, ctx);
      }
    } catch (error: any) {
      result = `Tool Error: ${error.message}`;
      logDebug(`Tool execution failed: ${error.message}`);
    }
    const toolCallMs = performance.now() - t0;
    execWindows.push({ index: entry.index, start: t0, end: t0 + toolCallMs, name: entry.call.function.name });
    logDebug(`✔ done ${label} [${Math.round(toolCallMs)}ms]`);
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
    logDebug(
      `Batch done: ${execEntries.length} tools, ` +
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
      logDebug(`Tool execution failed: ${msg}`);
    }
  });

  // ----------------------------------------------------------------
  // PHASE 3 cut point — commit in original index order in the caller.
  // Tool messages must be appended in tool_calls order so each
  // tool_call_id pairs correctly with the assistant message.
  // ----------------------------------------------------------------
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

  return { plan, results, wasAborted, commitUpTo, abortMarkerIndex };
}
