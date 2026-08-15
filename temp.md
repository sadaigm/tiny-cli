# Ink-Based TUI Rewrite — Task Checklist

## Phase 1: Foundation & Configuration

- [ ] Add Ink/React dependencies to `packages/cli/package.json` (`ink`, `react`, `ink-spinner`, `@types/react`)
- [ ] Update `packages/cli/tsconfig.json`: add `\"jsx\": \"react-jsx\"`, `\"jsxImportSource\": \"react\"`, add `\"DOM\"` to `lib`
- [ ] Create `packages/cli/src/tui/` directory structure
- [ ] Create `tui/state.ts` with `LogEntry`, `TuiState`, `AgentState`, `TuiMode` type definitions
- [ ] Create `tui/utils/deferred.ts` with `createDeferred<T>()` utility
- [ ] Create `tui/utils/messageQueue.ts` with enqueue/dequeue/peek for messages submitted while agent is busy
- [ ] Verify `pnpm install` succeeds with new dependencies

## Phase 2: Core Components

- [ ] Create `tui/components/Spinner.tsx` — wraps `ink-spinner` with status text
- [ ] Create `tui/components/Header.tsx` — renders app banner, model name, endpoint, session ID
- [ ] Create `tui/components/StatusBar.tsx` — renders current mode, context stats (tokens/chars), permission mode
- [ ] Create `tui/components/MessageItem.tsx` — renders a single `LogEntry` with appropriate color/icon (user=green, assistant=blue, tool_call=cyan+🔧, tool_result=gray, error=red, system=dim)
- [ ] Create `tui/components/MessageLog.tsx` — scrollable container that renders `LogEntry[]`, auto-scrolls to bottom, respects terminal height
- [ ] Create `tui/components/InputBox.tsx` — always-live `ink-text-input` that submits on Enter, shows prompt prefix with mode indicator, stays interactive regardless of agent state
- [ ] Create `tui/components/AutocompletePopover.tsx` — reusable popup showing filtered items with keyboard navigation (↑/↓), used for `/` commands and `@` file mentions

## Phase 3: Agent Integration

- [ ] Create `tui/hooks/useConsoleCapture.ts` — intercepts `console.log`/`console.error` and routes output to message log
- [ ] Create `tui/hooks/useAgent.ts` — core hook implementing concurrent execution model:
  - [ ] `submitMessage(text)` — enqueues if agent busy, runs immediately if idle
  - [ ] `runAgentTurn(input)` — calls `agent.run()` with `onStep` callback streaming to log, NOT awaited by render cycle
  - [ ] `abortCurrentRun()` — triggers AbortController (Escape/Ctrl+C)
  - [ ] Queue drain — after each turn, dequeue and run next queued message
  - [ ] `showApprovalModal(call)` — sets `pendingApproval` state, returns deferred promise
  - [ ] Session save — persist `agent.getHistory()` after each turn via `SessionManager`
- [ ] Create `tui/components/ApprovalModal.tsx` — renders pending tool call details, shows Approve/Approve-Session/Cancel/Abort buttons, resolves deferred promise on selection

## Phase 4: Root App Component

- [ ] Create `tui/app.tsx` — root `<App>` component that:
  - [ ] Owns `TuiState` via `useState`/`useReducer`
  - [ ] Renders `<Header>`, `<MessageLog>`, `<Spinner>` (when running), `<InputBox>`, `<ApprovalModal>` (when pending)
  - [ ] Wires `useConsoleCapture` hook
  - [ ] Wires `useAgent` hook with agent instance
  - [ ] Handles global keyboard: Escape aborts, Ctrl+C exits cleanly
  - [ ] Manages slash command dispatch (`/agent`, `/chat`, `/plan`, `/clear`, `/exit`, `/model`, `/tools`, `/session`, `/mode`, `/mcp`, `/continue`)
  - [ ] Handles `@file` mention hydration via existing `hydrateMessage()` from `file-mention.ts`
- [ ] Create `tui/render.tsx` — entry point that imports `render` from `ink`, mounts `<App>`, cleans up on unmount

## Phase 5: Slash Command Inline Selectors

- [ ] Refactor `handleModelCommand` in `commands/handlers.ts` — extract model-fetching logic into pure async function, remove inquirer/ora; TUI will call the pure function and render results inline
- [ ] Implement model picker as inline Ink overlay (fetch models → show AutocompletePopover → call `agent.updateConfig`)
- [ ] Implement session manager as inline Ink overlay (list/load/new sessions using `SessionManager`)
- [ ] Implement permission mode picker as inline Ink overlay (notify/auto-edit/auto)
- [ ] Implement MCP manager as inline Ink overlay (list servers, reconnect/disconnect/list tools)
- [ ] Implement tools list as inline rendering (read-only list of tool definitions for current mode)

## Phase 6: Plan Execution

- [ ] Port `executeActivePlan()` logic from `repl.ts` into `useAgent` hook or a dedicated `usePlanExecution` hook
- [ ] Stream per-task progress to message log (task N/M, tool calls, timing)
- [ ] Use deferred-promise approval modals during plan execution
- [ ] Implement Escape abort during plan execution via AbortController
- [ ] Implement \"task not marked complete\" recovery modal (Retry/Manual/Skip/Stop) as inline Ink selector
- [ ] Wire `/continue` and bare \"continue\" to trigger plan execution

## Phase 7: Entry Point & Cleanup

- [x] Modify `index.ts` — when no query provided, call `startTui(resume, mode)` instead of `startRepl()`
- [ ] Verify headless mode (with query) remains unchanged and uses raw `agent.run()` without Ink
- [x] Deprecate `repl.ts` (file deleted)
- [x] Remove `inquirer`, `inquirer-autocomplete-prompt`, `ora` from `packages/cli/package.json` dependencies
- [x] Remove `@types/inquirer`, `@types/inquirer-autocomplete-prompt` from devDependencies
- [x] Verify TypeScript build (`tsc`) passes with new JSX config
- [ ] End-to-end test: start TUI, type a message, confirm agent output streams while input remains live
- [x] End-to-end test: type while agent is working, confirm message is queued and processed after turn completes — **automated**: `test/useAgent-queue.test.tsx` proves queue + FIFO drain with a stubbed Agent; `test/messageQueue.test.ts` covers the FIFO data structure (12 tests, `pnpm test`)
- [ ] End-to-end test: tool approval modal appears and resolves correctly
- [ ] End-to-end test: slash commands work (`/agent`, `/model`, `/session`, `/mode`, `/clear`, `/exit`)
- [ ] End-to-end test: `@file` mention autocomplete and hydration works
- [ ] End-to-end test: plan mode planning + `/continue` execution works
- [ ] End-to-end test: Escape/Ctrl+C abort works during agent execution

---

## Phase 8: Two-Pane Layout & Conversation UX Overhaul

> Addresses: tool args dumping entire file contents, status bar stretching,
> no way to see hidden history, and unwrapped long output.

- [x] `tui/utils/toolSummary.ts` — per-tool smart summaries (write/read/bash/grep/glob/etc.), `wrapIndent`, defensive JSON parse
- [x] `tui/components/MessageItem.tsx` — collapsed one-line summaries + expanded detail; soft-wrapped user/assistant text; `focused`/`expanded`/`columns` props
- [x] `tui/components/MessageLog.tsx` — focusable scroll viewport: local `useReducer` (focus/expanded/autoFollow), `computeWindow`, `↑ N above · ↓ M below` header, focused highlight, keyboard nav (↑/↓/PgUp/PgDn/Tab/Home/End), `useImperativeHandle` for mouse
- [x] `tui/components/StdinMouseBridge.tsx` — SGR mouse-mode enable + wheel-event parsing → scroll (Ink v5 has no native mouse)
- [x] `tui/app.tsx` — bordered two-pane layout (top conversation / middle input / bottom agent-details box with Header + StatusBar); `paneKeysActive` key-precedence ladder; `/mouse` command; height budget from `useStdout`; `isActive` on selector hook; global-hook early-returns
- [x] `tui/components/StatusBar.tsx` — left-packed row (no full-width stretch)
- [x] `tui/components/Header.tsx` — compact 2-line banner
- [x] `tui/state.ts` — `mouseEnabled` field
- [x] `test/toolSummary.test.ts` — 19 tests (per-tool fields, defensive parse, wrapIndent)
- [x] Build (`tsc`) passes; `pnpm test` 31/31 green (no regression to queue tests)
- [ ] Manual E2E: large `write` renders as one-line summary; ↑/↓ focus + Tab expand; mouse wheel scrolls; scrolled-up view stays put with `↓ N new below`; `/mouse` toggle; status bar no longer stretches

---

## Phase 9: UX Enhancements (see tui-enhancement-mvp.md)

- [x] `tui/utils/inputHistory.ts` — shell-style ↑/↓ recall cursor (draft
      preservation, consecutive-dedupe, capped ring, trim/empty rejection)
- [x] `tui/components/InputBox.tsx` — history wired in: submits recorded,
      ↑/↓ recall when no picker is open, recalled lines routed through
      `handleChange` so `/` and `@` pickers react consistently
- [x] `app.tsx` — Ctrl+C requires a second press within 2 s to exit (first
      press logs a hint); Ctrl+D exits immediately; Esc still aborts the turn
- [x] `/help` (and `/?`) — lists all commands from `SLASH_COMMANDS` plus a
      keybinding reference (`HELP_KEY_LINES`)
- [x] `/queue` and `/queue clear` — inspect/drop queued messages; new
      `clearQueue()` API on `useAgent` (in-flight turn unaffected)
- [x] `utils/commands.ts` — `queue` + `help` registered in the `/` picker
- [x] `test/inputHistory.test.ts` — 12 tests (cursor semantics, draft,
      dedupe, cap, clear, reset)
- [x] Build passes; `pnpm test` 69/69 green
- [ ] Manual E2E: history recall + pickers on recalled lines; Ctrl+C ×2;
      `/help`; `/queue clear` mid-turn

---

## Phase 10: Hardening from the P0 review

> E2E automation was explored and dropped for the MVP — a PTY+scripted-model
> harness encodes this iteration's UI strings and changes every iteration,
> which is dead weight to maintain. The valuable outcomes below are direct
> product fixes found by reading the code paths; verification stays with the
> unit suites + manual smoke testing.

- [x] **Modal key-precedence fix** — `focus` prop on InputBox/TextInput;
      blurred while approval/recovery/selector overlays own the keyboard
      (quick-select keys y/s/n/a no longer leak into the text draft)
- [x] **Batched-keystroke stale-closure fixes** — arrows + Enter arriving
      in one stdin chunk (fast typing, paste of key sequences) previously
      acted on a stale `selected`/`highlighted` index because the
      `useInput` closure ran before React re-rendered. Now mirrored in
      refs for synchronous reads:
      - `app.tsx` selector overlay (MOVE_SELECTOR path replaced with
        ref-tracked PATCH)
      - `RecoveryModal.tsx` (`selectedRef`)
      - `ApprovalModal.tsx` (`highlightedRef`, Enter path)
- [ ] Verify build + unit tests after these fixes (`pnpm build && pnpm test`)

