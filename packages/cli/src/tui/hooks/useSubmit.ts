import { useCallback, type RefObject } from "react";

import { hydrateMessage } from "../../file-mention.js";
import { readPlanTaskFile, parseIncompleteTasks } from "../utils/planReader.js";
import type { MessageLogHandle } from "../components/MessageLog.js";
import type { UseAgentApi } from "./useAgent.js";
import type { TuiState } from "../state.js";

/** Minimal shape of App's `stateRef` (avoids importing the component). */
type StateRef = { current: TuiState };

/**
 * Free-form phrases that express clear intent to run the plan task-by-task
 * (not just the bare `continue` keyword). Matched against a normalized
 * (lowercased, trailing punctuation stripped) input.
 */
const PLAN_EXECUTION_INTENT =
  /^(?:go|start|run|begin|proceed|execute)(?:\s+(?:the\s+)?(?:with\s+)?(?:this\s+)?plan\b|\s+task\s+by\s+task)|^task\s+by\s+task$|^execute\s+(?:the\s+)?tasks?$/;

/** True when the active session's plan has at least one `- [ ]` task. */
async function hasPendingPlanTasks(
  stateRef: StateRef,
  sessionId: string,
): Promise<boolean> {
  const sid = stateRef.current._sessionId ?? sessionId;
  const content = await readPlanTaskFile(sid);
  return parseIncompleteTasks(content).length > 0;
}

export interface UseSubmitProps {
  sessionId: string;
  stateRef: StateRef;
  paneRef: RefObject<MessageLogHandle | null>;
  agentApi: UseAgentApi;
  handleSlashCommand: (text: string) => Promise<unknown>;
}

/**
 * Input submission handler, extracted from App so the render path in
 * app.tsx stays thin (also isolates it for debugging).
 *
 * Order: slash commands → plan-execution intent → hydrate @mentions →
 * agentApi.submitMessage (display text keeps @path, model gets <file>
 * blocks).
 */
export function useSubmit({
  sessionId,
  stateRef,
  paneRef,
  agentApi,
  handleSlashCommand,
}: UseSubmitProps) {
  const handleSubmit = useCallback(
    async (text: string) => {
      // Slash command?
      if (text.startsWith("/")) {
        await handleSlashCommand(text);
        return;
      }

      // Explicit plan-execution intent triggers the structured task-by-task
      // executor (with per-task banners). Users rarely type the bare
      // "continue" keyword — phrases like "go task by task" previously fell
      // through to free-form chat, where the agent ran all tasks in one
      // turn with no visible task progress. Only route when pending tasks
      // exist — otherwise the message must reach the agent normally.
      const normalized = text
        .toLowerCase()
        .trim()
        .replace(/[.!]+$/, "");
      if (
        normalized !== "continue" &&
        PLAN_EXECUTION_INTENT.test(normalized) &&
        (await hasPendingPlanTasks(stateRef, sessionId))
      ) {
        agentApi.executePlan();
        return;
      }
      // Bare "continue" always starts plan execution (the planner prompt
      // ends with 'Type `continue` to start executing this plan.').
      if (normalized === "continue") {
        agentApi.executePlan();
        return;
      }

      // Sending a message is intent to follow the conversation again —
      // re-arm auto-follow so responses land in view even if the user had
      // scrolled up to read earlier history.
      paneRef.current?.focusBottom();

      // Hydrate @file mentions then submit. The hydrated text (with
      // <file> blocks) goes to the model; the original text (with @path
      // mentions) is what gets displayed in the log.
      const display = text.replace(/\[@([^\]]+)\]/g, "@$1");
      try {
        const hydrated = await hydrateMessage(text);
        agentApi.submitMessage(hydrated, display);
      } catch {
        agentApi.submitMessage(text, display);
      }
    },
    [handleSlashCommand, agentApi, paneRef, stateRef, sessionId],
  );

  return handleSubmit;
}
