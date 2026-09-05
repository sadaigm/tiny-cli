import type { ToolCall, AskUserPayload, AskUserResponse } from '@tiny-cli/core';
import { createDeferred } from '../utils/deferred.js';
import type { ApprovalChoice, AgentRefs, UseAgentSetState } from './agentTypes.js';

/**
 * Approval / questionnaire modal plumbing, split out of useAgent.ts
 * (mechanical move — bodies verbatim).
 *
 * `showApprovalModal` / `showQuestionnaire` are called synchronously by
 * `agent.run()`'s `onApproval` / `onAskUser` callbacks; the `resolve*`
 * functions are the public API the modals call to settle the deferreds.
 */
export interface ApprovalsApi {
  showApprovalModal: (call: ToolCall) => Promise<ApprovalChoice>;
  showQuestionnaire: (payload: AskUserPayload) => Promise<AskUserResponse>;
  resolveApproval: (choice: ApprovalChoice) => void;
  resolveQuestionnaire: (response: AskUserResponse) => void;
}

export function createApprovals(deps: {
  setState: UseAgentSetState;
  refs: AgentRefs;
}): ApprovalsApi {
  const { setState, refs } = deps;

  /**
   * Display the approval modal and return the user's decision via a
   * deferred promise.
   *
   * Sets `pendingApproval` state so the `<ApprovalModal>` renders,
   * then awaits the deferred promise.  The UI calls `resolveApproval()`
   * to settle the promise.
   */
  const showApprovalModal = async (call: ToolCall): Promise<ApprovalChoice> => {
    const deferred = createDeferred<ApprovalChoice>();
    refs.approvalDeferredRef.current = deferred;

    setState({
      agentState: 'awaiting_approval',
      pendingApproval: call,
    });

    const result = await deferred.promise;

    setState({
      agentState: 'running',
      pendingApproval: null,
    });

    return result;
  };

  /**
   * Display the questionnaire modal and return the user's answers via a
   * deferred promise.
   *
   * Sets `pendingQuestions` state so `<QuestionnaireModal>` renders;
   * the UI calls `resolveQuestionnaire()` to settle the promise.
   */
  const showQuestionnaire = async (payload: AskUserPayload): Promise<AskUserResponse> => {
    const deferred = createDeferred<AskUserResponse>();
    refs.questionnaireDeferredRef.current = deferred;

    setState({
      agentState: 'awaiting_approval',
      pendingQuestions: { payload, currentIndex: 0, answers: [] },
    });

    const result = await deferred.promise;

    setState({
      agentState: 'running',
      pendingQuestions: null,
    });

    return result;
  };

  /**
   * Resolve the pending approval modal.
   *
   * Called by `<ApprovalModal>` when the user selects an option.
   * Settles the deferred promise, unblocking `agent.run()`'s
   * `onApproval` callback.
   */
  const resolveApproval = (choice: ApprovalChoice): void => {
    const deferred = refs.approvalDeferredRef.current;
    if (deferred) {
      refs.approvalDeferredRef.current = null;
      deferred.resolve(choice);
    }
  };

  /**
   * Resolve the pending questionnaire modal.
   *
   * Called by `<QuestionnaireModal>` when the user answers all questions
   * or skips.  Settles the deferred promise, unblocking `agent.run()`'s
   * `onAskUser` callback.
   */
  const resolveQuestionnaire = (response: AskUserResponse): void => {
    const deferred = refs.questionnaireDeferredRef.current;
    if (deferred) {
      refs.questionnaireDeferredRef.current = null;
      deferred.resolve(response);
    }
  };

  return { showApprovalModal, showQuestionnaire, resolveApproval, resolveQuestionnaire };
}
