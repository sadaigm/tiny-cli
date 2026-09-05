import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';

export function register(registry: ToolRegistry) {
  // ask_user
  const askUserDef: ToolDefinition = {
    name: 'ask_user',
    description: [
      'Ask the user a questionnaire with multiple-choice options and receive their selections.',
      '',
      'How to use:',
      '1. Provide 1-5 questions, each with 2-8 concise options (single select).',
      '2. Set `context` to one line explaining WHY you need this info — it is shown to the user as a lead-in.',
      '3. The user picks one option per question; the answers come back as this tool\'s result.',
      '',
      'When to use:',
      '- Requirements are ambiguous or underspecified (e.g. which provider/library/styling approach).',
      '- Multiple valid approaches exist with meaningfully different tradeoffs.',
      '- Before large or irreversible work where a wrong guess is costly.',
      '- The user has a preference you cannot infer from the repo or history.',
      '',
      'When NOT to use:',
      '- Do not ask what `read`/`grep`/`glob` can discover from the codebase — investigate first.',
      '- Do not re-ask anything already answered in the conversation history.',
      '- Keep it short: max 5 questions and 2-8 concise options each.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'One line explaining why you need this info (shown to the user)' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          description: 'Questions to ask the user, in order',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 8,
                items: { type: 'string' },
                description: 'Single-select answer choices'
              }
            },
            required: ['question', 'options']
          }
        }
      },
      required: ['questions']
    }
  };
  registry.register(askUserDef, async (args, context) => {
    const questions = args?.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return 'Error: `questions` must be a non-empty array of {question, options}.';
    }
    if (questions.length > 5) {
      return `Error: \`questions\` supports at most 5 questions (got ${questions.length}).`;
    }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q || typeof q.question !== 'string' || q.question.trim().length === 0) {
        return `Error: questions[${i}] must have a non-empty string \`question\`.`;
      }
      if (!Array.isArray(q.options) || q.options.length < 2) {
        return `Error: questions[${i}] must have an \`options\` array with at least 2 entries.`;
      }
      if (q.options.length > 8) {
        return `Error: questions[${i}] supports at most 8 options (got ${q.options.length}).`;
      }
      for (const opt of q.options) {
        if (typeof opt !== 'string' || opt.trim().length === 0) {
          return `Error: questions[${i}] options must be non-empty strings.`;
        }
      }
    }
    if (!context?.askUser) {
      return 'No interactive user available — proceed with your best judgment and state your assumptions.';
    }
    try {
      const response = await context.askUser({ context: args.context, questions });
      if (response.kind === 'skipped') {
        return 'User skipped the questionnaire (no answer given). Proceed with your best judgment and state your assumptions clearly.';
      }
      const lines = ['User answered your questions:'];
      response.answers.forEach((a, i) => {
        lines.push(`${i + 1}. ${a.question} → ${a.selected}`);
      });
      return lines.join('\n');
    } catch (error: any) {
      return `Error asking user: ${error?.message ?? 'unknown error'}. Proceed with your best judgment and state your assumptions.`;
    }
  });
}
