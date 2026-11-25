import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../registry.js';

export function register(registry: ToolRegistry) {
  // 1. assign_task
  registry.register(
    {
      name: 'assign_task',
      description:
        'Assign a sub-task to a background sub-agent. The sub-agent runs autonomously on a worker model and executes the task in the background. You will be AUTOMATICALLY notified when it completes or fails — do NOT poll in a loop and do NOT sleep waiting for it. Use check_sub only for on-demand inspection. After assigning, continue with other work or end your turn.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Clear, detailed instructions for the sub-agent to execute.',
          },
          name: {
            type: 'string',
            description: 'Short human-readable name for this sub-agent (e.g. "auth-jwt", "db-migration").',
          },
          profile: {
            type: 'string',
            description: 'Optional worker profile name to use (from available sub-agent profiles).',
          },
          context_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional file paths the sub-agent should read first for context.',
          },
        },
        required: ['task'],
      },
    },
    async (
      args: { task: string; name?: string; profile?: string; context_files?: string[] },
      context?: ToolContext
    ) => {
      const mgr = context?.subAgentManager;
      if (!mgr) {
        return 'Error: SubAgentManager is not initialized for this session.';
      }
      if (!context?.sessionId) {
        return 'Error: No active session ID.';
      }

      try {
        const instance = await mgr.spawn({
          task: args.task,
          name: args.name,
          profile: args.profile,
          contextFiles: args.context_files,
          parentSessionId: context.sessionId,
          cwd: context.cwd,
        });

        return `Sub-agent "${instance.name}" (ID: ${instance.id}) spawned successfully with model "${instance.profile.model}". It is now executing in the background. You can monitor it using check_sub(id="${instance.id}").`;
      } catch (err: any) {
        return `Failed to spawn sub-agent: ${err.message}`;
      }
    }
  );

  // 2. check_sub
  registry.register(
    {
      name: 'check_sub',
      description:
        'Check the status, conversation history, or completion summary of active or completed sub-agents.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'ID of the specific sub-agent to inspect. Omit to list all sub-agents.',
          },
          action: {
            type: 'string',
            enum: ['status', 'summary', 'conversation', 'list'],
            description:
              'Action to perform. "list" lists all sub-agents. "status" returns current status. "summary" returns final result. "conversation" returns recent message history.',
            default: 'status',
          },
        },
      },
    },
    async (
      args: { id?: string; action?: 'status' | 'summary' | 'conversation' | 'list' },
      context?: ToolContext
    ) => {
      const mgr = context?.subAgentManager;
      if (!mgr) {
        return 'Error: SubAgentManager is not initialized for this session.';
      }

      const action = args.action || (args.id ? 'status' : 'list');

      if (action === 'list' || !args.id) {
        const list = mgr.list();
        if (list.length === 0) {
          return 'No sub-agents have been spawned in this session.';
        }
        return (
          `Active sub-agents (${list.length}):\n` +
          list
            .map(
              (s) =>
                `- [${s.id}] ${s.name} (${s.model}) — Status: ${s.status}${
                  s.currentTool ? `, Tool: ${s.currentTool}` : ''
                }${s.summary ? ` — Summary: ${s.summary.slice(0, 100)}...` : ''}`
            )
            .join('\n')
        );
      }

      const summary = mgr.getSummary(args.id);
      if (!summary) {
        return (
          `Error: Sub-agent with ID "${args.id}" not found. It may have never existed or its record is gone. ` +
          `Do NOT retry with this ID — run check_sub with action "list" to see all sub-agents and their current statuses, then proceed based on that.`
        );
      }

      if (action === 'status') {
        return (
          `Sub-agent "${summary.name}" (ID: ${summary.id}):\n` +
          `- Status: ${summary.status}\n` +
          `- Model: ${summary.model}\n` +
          `- Current Tool: ${summary.currentTool ?? 'none'}\n` +
          `- Started: ${new Date(summary.startedAt).toLocaleTimeString()}` +
          (summary.error ? `\n- Error: ${summary.error}` : '') +
          (summary.summary ? `\n- Summary: ${summary.summary}` : '')
        );
      }

      if (action === 'summary') {
        if (!summary.summary) {
          return `Sub-agent "${summary.name}" (ID: ${summary.id}) has not produced a summary yet (current status: ${summary.status}).`;
        }
        return `Summary for Sub-agent "${summary.name}" (${summary.id}):\n${summary.summary}`;
      }

      if (action === 'conversation') {
        const history = mgr.getConversation(args.id);
        if (history.length === 0) {
          return `Sub-agent "${summary.name}" has no messages in its conversation history yet.`;
        }
        const recent = history.slice(-10);
        return (
          `Recent messages for sub-agent "${summary.name}" (${recent.length} of ${history.length}):\n` +
          recent
            .map(
              (m) =>
                `[${m.role.toUpperCase()}]: ${
                  m.content
                    ? m.content.slice(0, 300)
                    : m.tool_calls
                    ? m.tool_calls.map((tc) => tc.function.name).join(', ')
                    : ''
                }`
            )
            .join('\n---\n')
        );
      }

      return `Unknown action "${action}". Use status, summary, conversation, or list.`;
    }
  );

  // 3. send_to_sub
  registry.register(
    {
      name: 'send_to_sub',
      description:
        'Send guidance, corrections, or clarification to a running or completed sub-agent. Injected directly into the sub-agent conversation as a mentor direction.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'ID of the sub-agent to send the message to.',
          },
          message: {
            type: 'string',
            description: 'Direction, clarification, or feedback for the sub-agent.',
          },
        },
        required: ['id', 'message'],
      },
    },
    async (args: { id: string; message: string }, context?: ToolContext) => {
      const mgr = context?.subAgentManager;
      if (!mgr) {
        return 'Error: SubAgentManager is not initialized for this session.';
      }

      const success = await mgr.sendToSub(args.id, args.message);
      if (!success) {
        return `Error: Sub-agent with ID "${args.id}" not found.`;
      }
      return `Direction successfully sent to sub-agent "${args.id}". It will take this guidance into account.`;
    }
  );

  // 4. ask_mentor
  registry.register(
    {
      name: 'ask_mentor',
      description:
        'Ask the mentor agent for guidance, review, or clarification when blocked or uncertain about task requirements.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question or clarification request for the mentor.',
          },
          context: {
            type: 'string',
            description: 'Relevant context, error message, or details to help the mentor answer.',
          },
        },
        required: ['question'],
      },
    },
    async (args: { question: string; context?: string }) => {
      const details = args.context ? ` (Context: ${args.context})` : '';
      return `Question submitted to mentor: "${args.question}"${details}. The mentor will review and inject guidance.`;
    }
  );
}

