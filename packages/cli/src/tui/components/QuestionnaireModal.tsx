import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from '../compat.js';
import type { AskUserAnswer, AskUserResponse } from '@tiny-cli/core';
import type { PendingQuestionnaire } from '../state.js';

/**
 * Props for the {@link QuestionnaireModal} component.
 */
export interface QuestionnaireModalProps {
  /** The active questionnaire awaiting user answers. */
  questionnaire: PendingQuestionnaire;
  /** Called when all questions are answered or the user skips. Resolves the deferred promise. */
  onDone: (response: AskUserResponse) => void;
}

/**
 * Modal overlay that walks the user through the agent's questionnaire.
 *
 * Rendered when `state.pendingQuestions` is non-null.  Shows the lead-in
 * context (why the agent is asking), the current question, and a vertical
 * option list.  Navigation via:
 *
 * - **↑ / ↓** — move highlight (wraps around)
 * - **Enter** — select highlighted option and advance; on the last
 *   question, finishes the questionnaire
 * - **Escape** — skip the questionnaire entirely
 *
 * On completion, calls `onDone(response)` which resolves the deferred
 * promise in `useAgent`, unblocking `agent.run()`.
 *
 * @example
 * ```tsx
 * {state.pendingQuestions ? (
 *   <QuestionnaireModal
 *     questionnaire={state.pendingQuestions}
 *     onDone={agentApi.resolveQuestionnaire}
 *   />
 * ) : null}
 * ```
 */
export default function QuestionnaireModal({
  questionnaire,
  onDone,
}: QuestionnaireModalProps): React.ReactElement {
  const { payload } = questionnaire;
  const questions = payload.questions;

  // Local walk state, synced from props when a new questionnaire arrives.
  const [currentIndex, setCurrentIndex] = useState(questionnaire.currentIndex);
  const [answers, setAnswers] = useState<AskUserAnswer[]>(questionnaire.answers);
  useEffect(() => {
    setCurrentIndex(questionnaire.currentIndex);
    setAnswers(questionnaire.answers);
  }, [questionnaire]);

  const [highlighted, setHighlighted] = useState(0);
  // Mirror for synchronous reads: arrow keys and Enter can arrive in one
  // stdin chunk before React re-renders, leaving the closure's
  // `highlighted` stale. The ref always holds the freshest value.
  const highlightedRef = useRef(0);
  highlightedRef.current = highlighted;
  // Same staleness guard for the current question index — Enter after a
  // question advance must read the index the previous render committed.
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  // Reset the option highlight whenever the displayed question changes.
  useEffect(() => {
    setHighlighted(0);
  }, [currentIndex]);

  const current = questions[Math.min(currentIndex, questions.length - 1)];
  const options = current?.options ?? [];

  useInput((input, key) => {
    // Escape = skip the whole questionnaire
    if (key.escape) {
      onDone({ kind: 'skipped' });
      return;
    }

    // Vertical navigation with wrap-around
    if (key.upArrow) {
      setHighlighted((prev) => (prev - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setHighlighted((prev) => (prev + 1) % options.length);
      return;
    }

    // Enter selects the highlighted option and advances
    if (key.return) {
      const selected = options[highlightedRef.current];
      if (!selected) return;
      const answer: AskUserAnswer = {
        question: current.question,
        selected,
      };
      const nextAnswers = [...answers, answer];
      const nextIndex = currentIndexRef.current + 1;
      if (nextIndex >= questions.length) {
        // Last question — the questionnaire is complete
        onDone({ kind: 'answered', answers: nextAnswers });
        return;
      }
      setAnswers(nextAnswers);
      setCurrentIndex(nextIndex);
      setHighlighted(0);
    }
  });

  // Row budget: title, optional context line, question, blank spacer,
  // hint, 2 border rows, and the top offset. Options get the remainder
  // (min 3 so short terminals still show a usable window).
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const FIXED_ROWS = payload.context ? 9 : 8;
  const top = 2;
  const optionBudget = Math.max(3, rows - top - FIXED_ROWS);

  // Scroll window: show a contiguous slice of options, keeping the
  // highlighted row visible (clamped so the window never overruns the
  // list while scrolling toward the end).
  const windowStart = Math.min(
    Math.max(0, highlighted - optionBudget + 1),
    Math.max(0, options.length - optionBudget),
  );
  const visibleOptions = options.slice(
    windowStart,
    windowStart + optionBudget,
  );

  return (
    // Absolute overlay: taken out of the flex flow so it floats over the
    // conversation without reserving rows or reflowing the layout.
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      backgroundColor="black"
      paddingX={1}
      position="absolute"
      top={top}
      left={2}
      width={columns - 4}
    >
      <Text color="yellow" bold>
        ❓ Quick questions ({currentIndex + 1}/{questions.length})
      </Text>

      {payload.context ? (
        <Text dimColor wrap="wrap">
          {payload.context}
        </Text>
      ) : null}

      <Text bold wrap="wrap">
        {current.question}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {visibleOptions.map((option, i) => {
          const optionIndex = windowStart + i;
          const isHighlighted = optionIndex === highlighted;
          return isHighlighted ? (
            <Text key={optionIndex} backgroundColor="yellow" color="black" bold>
              {' '}
              › {option}{' '}
            </Text>
          ) : (
            <Text key={optionIndex} color="gray">
              {' '}
              &nbsp;&nbsp;{option}{' '}
            </Text>
          );
        })}
      </Box>

      <Text dimColor>
        ↑/↓ select · Enter confirm · Esc cancel questionnaire
      </Text>
    </Box>
  );
}
