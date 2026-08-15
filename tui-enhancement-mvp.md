# TUI Enhancement MVP

Scope and status for the Ink-based TUI (`packages/cli/src/tui/`). The core
rewrite (Phases 1–8, tracked in `temp.md`) is **shipped**: concurrent
execution model, queue-while-typing, approval/recovery modals, plan
execution, two-pane layout, browse mode, smart tool summaries.

This document is the enhancement backlog on top of that baseline.

---

## Baseline (what already works)

| Capability | Where |
|:---|:---|
| Always-live input; queue while agent runs | `hooks/useAgent.ts`, `utils/messageQueue.ts` |
| ↑/↓ input history recall (shell-style, draft-preserving) | `utils/inputHistory.ts`, `components/InputBox.tsx` |
| `/`-command and `@`-file pickers with fuzzy filter | `components/InputBox.tsx`, `AutocompletePopover.tsx` |
| Multi-line paste chips + Shift+Enter newlines | `utils/pasteChip.ts`, `components/TextInput.tsx` |
| Approval / recovery / selector modals | `components/ApprovalModal.tsx`, `RecoveryModal.tsx` |
| Plan execution with per-task recovery | `hooks/useAgent.ts` (`executePlan`) |
| Two-pane layout: conversation / input / agent details | `app.tsx` |
| Browse mode (Ctrl+P): scroll, Tab-expand, mouse wheel | `components/MessageLog.tsx`, `StdinMouseBridge.tsx` |
| Collapsed one-line tool summaries + expand | `utils/toolSummary.ts`, `components/MessageItem.tsx` |
| Ctrl+C double-press exit guard; Esc aborts turn | `app.tsx` |
| `/help`, `/queue [clear]` | `app.tsx`, `utils/commands.ts` |

---

## P0 — required for MVP

These close the remaining gaps from the rewrite checklist (`temp.md`
Phase 7/8 manual E2E items) plus this round's features.

- [ ] **Manual E2E sweep** (needs a live model endpoint):
  - [ ] Type a message → agent streams while input stays live
  - [ ] Type mid-turn → queued, then FIFO-drained
  - [ ] Approval modal appears and resolves (approve / session / cancel / abort)
  - [ ] Slash commands: `/agent /chat /plan /model /session /mode /clear /exit`
  - [ ] `@file` mention: picker, insert, hydration into context
  - [ ] Plan mode → `/continue` executes tasks; recovery modal on incomplete task
  - [ ] Esc aborts a running turn; Ctrl+C ×2 exits; Ctrl+D immediate
  - [ ] ↑/↓ recall history; draft preserved; pickers still work on recalled lines
  - [ ] Large `write` renders one-line summary; Tab expands
  - [ ] Mouse wheel scrolls (after `/mouse on`); status bar never stretches
- [ ] **/help and /queue live check** — verify rendering in the log pane and
      `/queue clear` dropping queued messages mid-turn
- [x] **Queue display integrity** — the `📬 N queued` strip and `/queue`
      agree with `useAgent`'s queue at all times (they read the same state,
      but confirm no path bypasses `queueRef` sync). Audited: enqueue /
      dequeue / clear / idle-exit / error-exit all sync `queueRef` → state,
      and the reducer never writes `messageQueue` directly, so there is no
      bypass path. Known behaviour (not a desync): a failed turn leaves
      queued messages pending, and `/clear` does not drop them.

## P1 — high-value next

- [x] **Persisted input history** — survive restarts, per-project.
      `~/.config/tiny-cli/input-history.json` buckets entries by a hash of
      the project root; hydrated on mount, saved fire-and-forget on submit
      (`utils/historyStore.ts`).
- [x] **Ctrl+R incremental history search** — reverse-i-search like a shell.
      `searchHistory()` in `utils/inputHistory.ts`; prompt UI + key handling
      in `components/InputBox.tsx` (Enter accepts to-edit · Esc cancels ·
      ↑/↓ step matches · query edit resets to newest).
- [x] **Message search** — `/find <text>` lists matches newest-first and
      jumps browse-mode focus to the most recent hit (`utils/logSearch.ts`,
      `focusEntry` on the MessageLog handle).
- [x] **Copy from log** — browse-mode `y` yanks the focused entry's raw
      content (tool args / result / message text) to the LOCAL clipboard
      via OSC 52 (`utils/clipboard.ts`) — the terminal itself copies, so
      it works over SSH/tmux with no xclip dependency.
- [x] **Token-accurate context meter** — tokens were already
      tiktoken-accurate (`agent.getContextStats`, cl100k_base); added the
      missing half: a 10-slot usage bar + percent of the 35k auto-compact
      threshold, colour-ramped green→yellow→red (`StatusBar.tsx`).
- [x] **Session switcher hotkey** — Ctrl+S (remappable) opens the `/session`
      picker from anywhere.
- [x] **Streaming assistant output** — `chat()` gains `onText`; when set it
      consumes the SSE endpoint, reassembles tool-call argument fragments,
      and falls back to buffered JSON on any stream failure
      (`core/model/client.ts`). `agent.run()` threads it through; the TUI
      streams deltas into a live log entry (`APPEND_LOG_TEXT`) and skips
      the duplicate final blob.

## P2 — polish

- [x] **Configurable keybindings** — `~/.tiny-cli/keys.json` remaps browse /
      history search / session switcher / abort / yank (`tui/keybindings.ts`,
      ctrl+X syntax, invalid specs fall back to defaults).
- [x] **Themes** — `~/.tiny-cli/theme.json` overrides semantic colour roles
      (user/assistant/tool/border/accent/warning…); invalid values ignored
      (`tui/theme.ts`).
- [x] **Word-wrap cursor motion** — ↑/↓ inside a multi-line draft (Shift+Enter)
      move the cursor by line, column preserved, clamped to the target line
      (`utils/lineMotion.ts`); single-line drafts still recall history.
- [x] **Link rendering** — URLs and absolute paths in message bodies are
      underlined (`utils/links.ts`). (Open-on-Enter deferred: browse mode's
      Tab already owns expand, and xdg-open from a TUI needs a config gate.)
- [x] **Notification bell** — terminal BEL (`\x07`) when a turn ≥10 s
      finishes (`useAgent`), so a backgrounded terminal pings its tab.
- [x] **`/compact` command** — `agent.compactNow()` in core forces the
      summarise-and-retain pass on demand; TUI reports before → after tokens
      and saves the session.

## Non-goals for MVP

- Full mouse support beyond wheel scroll (click-to-focus, drag-select) —
  Ink 7 has no pointer events; SGR parsing only goes so far.
- Arbitrary layout customization / pane resizing with the keyboard.
- Split conversation views (e.g. side-by-side diff pane).
