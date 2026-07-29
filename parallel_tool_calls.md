# Parallel Tool-Call Execution in `Agent.run()`

## Context

When the model returns multiple tool calls in a single response (a "batch"), the agent executes them **strictly sequentially** — one `await` at a time inside a `for...of` loop. The logs show this clearly: `[Agent] Executing N tool calls...` followed by one-at-a-time `🔧 Tool:` lines. For independent operations (parallel reads/greps, or edits to *different* files) this wastes wall-clock time.

This change parallelizes execution **within a single batch** while preserving correctness: message ordering, redundancy dedupe, interactive permission prompts, abort handling, and filesystem safety.

**Scope (confirmed):** inner batch loop in `agent.ts` only. The outer `Executing task 1/57` loop in `repl.ts` (one `agent.run()` per plan task) stays sequential — plan tasks are dependent and share state.

## The change

Replace the sequential `for (const call of response.tool_calls)` loop at **`packages/core/src/agent.ts:189-277`** with a four-phase batch processor. Everything outside that range (model call at 168, assistant-message push at 181-185, the `else` terminal branch at 278-285, max-iterations path) is untouched.

```
PHASE 0 (snapshot):  freeze dedupe baseline from `steps` (before this batch)
PHASE 1 (gating):    sequential, in index order: dedupe + permission prompts  -> plan[]
PHASE 2 (execute):   concurrent execution of approved/non-dup calls, lock-grouped
PHASE 3 (commit):    append messages/steps in original index order; handle abort
```

### PHASE 0 — Snapshot
Compute `preBatchKeys = new Set(steps.filter(s=>s.toolCall).map(s=>name:argStr))` once. Also keep a `seenInBatch = new Set()` for within-batch dedupe (see decision below). Replaces the per-iteration `previousCalls` recomputation at 194-196.

### PHASE 1 — Gating (sequential, replaces 189-238 logic)
Iterate `response.tool_calls` in index order. For each call, in order:
1. `callKey = name:argStr`.
2. **Redundancy** — if `preBatchKeys.has(callKey)` **or** `seenInBatch.has(callKey)` → `plan.push({kind:'REDUNDANT'})`, continue. **Decision (preserve current behavior):** block within-batch duplicates, so add each executed `callKey` to `seenInBatch`. This matches today exactly (today the 2nd identical same-batch call is blocked).
3. **Permission** — re-read `this.config.permissionMode` each iteration (as line 219 does today) so an "Approve (Session)" choice (`onApproval` mutating `permissionMode='auto'`, repl.ts:259/629) flips the *rest of this batch* to auto-run. Determine `needsApproval` exactly as 220-230 (notify=always; auto-edit=only `bash`+isModifying). If needed, `await onApproval(call)` sequentially — prompts must not overlap. Denied → `kind:'DENIED'`.
4. Otherwise → `kind:'EXEC'` with parsed args + resolved `lockKey`.

Check `signal?.aborted` at the top of each Phase-1 iteration and break early for responsiveness.

Output: ordered `plan[]`, no tool executed yet.

### PHASE 2 — Concurrent execution (replaces 240-256)
A `classify(call)` helper assigns each EXEC entry a `lockKey`:
- `bash` → `__bash__` (global wildcard; serializes against all mutations — bash has unbounded reach).
- `search_replace` / `insert_lines` / `write` → `path.resolve(cwd, args.path)`.
- `manage_tasks` / `mark_task_complete` → shared `TASK_FILE` key = `.tiny-cli/<sessionId>/plan/current_task.md` (both RMW this file today — guaranteed race; this fixes it).
- `plan_write` → `path.resolve(planDir, args.path)`.
- `read` / `list` / `grep` / `glob` → `null` (fully parallel).
- `mcp__*` → **decision:** lock against file writes only. Implement as a special `__mcp__` key that conflicts with every mutating built-in key but **not** with read-only tools. So MCP runs parallel to reads, serialized against any `bash`/`write`/`search_replace`/`insert_lines`/task/`plan_write`. (No `isModifying` metadata exists for MCP tools.)

Per-key async mutex (promise-chain `MutexMap`, created **per `run()`**, no external dep). `acquire(null)` is a no-op. Each entry:
```
await acquire(lockKey)
try { if (signal?.aborted) return {aborted:true}; t0=now();
      try { result = name.startsWith('mcp__') ? await mcpManager.callTool(...)
                                               : await registry.call(...) }
      catch(e){ result = `Tool Error: ${e.message}` }
      return {result, toolCallMs: now()-t0, aborted: signal?.aborted} }
finally { release(lockKey) }
```
Wrap `classify`'s arg parsing so malformed args fall back to a unique serializing key (never throw before the try/catch). Dispatch all EXEC entries with **`Promise.allSettled`** (never `Promise.all` — one rejection must not discard others' results). REDUNDANT/DENIED entries are not dispatched.

### PHASE 3 — Commit in index order (replaces 257-276)
Collect results into `results[i]`. REDUNDANT/DENIED get precomputed message strings + `toolCallMs` omitted (`timing.toolCallMs` undefined). Then, in original index order `0..n-1`:
- **Abort:** if `signal?.aborted`, find lowest aborted index, commit `[0..that]` (suffix aborted entry's result with `\n\n[Execution aborted by user]` per line 262), push steps, return `{content:"Execution cancelled by user.", steps}`. Discard later indices.
- **Normal:** push `tool`-role message `{role:'tool', tool_call_id:call.id, content:result}`, `if(onStep) onStep(step)` (fired in index order → UI ordering preserved), `steps.push(step)`.

Each `tool_call_id` is matched to its own call, so the model sees a well-formed assistant+tools exchange regardless of execution timing.

## Files to modify

- **`packages/core/src/agent.ts`** — sole edit site: replace loop body 189-277; add `MutexMap` + `classify` helpers (top of file or a new `util.ts`). ~90 lines become the four phases.
- *Read-only references (no edits):* `tools/definitions.ts` (confirms mutating tools + path resolution), `types.ts` (`AgentStep.timing`, `PermissionMode`), `cli/src/repl.ts` (`onApproval` side effects at 224-270 / 596-640), `mcp/manager.ts` (`loadTools` never sets `isModifying`).

## Verification

1. **Build:** `pnpm build` (root) — TypeScript must compile clean across `packages/core` and `packages/cli`.
2. **Batch-of-1 parity:** run a prompt that triggers a single tool call — confirm identical output/timing to before (no regression).
3. **Parallel reads:** trigger a batch with multiple `read`/`grep` calls; confirm they run concurrently (wall-clock < sum of individual, `🔧 Tool:` lines still print in index order).
4. **Same-file safety:** a batch with two `write`/`search_replace` to the **same** path — assert no lost update (mutex serializes).
5. **Task-tool race:** a batch with both `manage_tasks` (`mark_done`) and `mark_task_complete` — assert `current_task.md` reflects both writes (today this corrupts).
6. **Permission flow:** in `notify` mode, a batch of 3 `bash` calls where the first is approved as "Approve (Session)" — assert the 2nd and 3rd auto-run without prompts (mid-batch `permissionMode` mutation preserved).
7. **Within-batch dup:** a batch emitting the same call twice — assert the 2nd is blocked as redundant (matches today).
8. **Abort:** a batch where the user aborts mid-flight — assert cancel response + partial commit up to the aborted index.
9. **Existing tests:** `pnpm test` — run the core/CLI test suites; all should pass unchanged.
