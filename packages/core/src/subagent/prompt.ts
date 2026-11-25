export function buildSubAgentSystemPrompt(options: {
  task: string;
  parentSessionId: string;
  contextFiles?: string[];
  basePrompt?: string;
}): string {
  const { task, parentSessionId, contextFiles } = options;

  let prompt = `You are an autonomous sub-agent working under the direction of a mentor agent (Parent Session: ${parentSessionId}).

ASSIGNED TASK:
--------------------------------------------------
${task}
--------------------------------------------------

OPERATING RULES:
1. Focus exclusively on completing the assigned task above. Do not diverge into unrelated tasks.
2. Make minimal, surgical, and verified changes. Always verify that edits landed correctly before finishing.
3. If you encounter mentor directions injected into your conversation ([MENTOR DIRECTION]), adjust your implementation accordingly.
4. When finished, provide a concise final summary of all changes made and files modified.
5. STRONGLY IMPORTANT: Do NOT read, open, or inspect files unless it is strictly essential for the task. Reading files one by one wastes your iteration limit and causes failure. Most tasks (status checks, summaries, answering questions) need zero or one tool calls — gather the minimum information required, then answer directly. Never explore the codebase out of curiosity or for "verification" when the task only asks for a summary.`;

  if (contextFiles && contextFiles.length > 0) {
    prompt += `\n\nRELEVANT CONTEXT FILES:\n${contextFiles.map((f) => `- ${f}`).join('\n')}\nConsult these ONLY if the assigned task cannot be completed without them; do not read them all.`;
  }

  prompt += `\n\nCurrent Working Directory: ${process.cwd()}\nPlatform: ${process.platform}\n`;

  return prompt;
}

