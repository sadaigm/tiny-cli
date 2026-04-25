import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { Agent, AgentStep, SessionManager, Session } from '@tiny-cli/core';
import { loadConfig, saveConfig } from './config.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function startRepl(resumeId?: string) {
  const config = await loadConfig();
  const agent = new Agent(config);
  const sessionManager = new SessionManager();

  // Load or create session
  let currentSessionId: string;
  let session: Session | null = null;

  if (resumeId) {
    session = await sessionManager.loadSession(resumeId);
    if (session) {
      currentSessionId = resumeId;
      agent.setHistory(session.messages);
      console.log(chalk.dim(`Resumed session: ${currentSessionId}`));
    } else {
      console.log(chalk.yellow(`Session ${resumeId} not found. Creating new session with that ID.`));
      session = SessionManager.createSession(resumeId);
      currentSessionId = resumeId;
    }
  } else {
    session = SessionManager.createSession();
    currentSessionId = session.metadata.id;
  }

  console.log(chalk.bold.cyan('\n🚀 tiny-cli Agent Ready'));
  console.log(chalk.dim(`Model: ${config.model} @ ${config.endpoint}`));
  console.log(chalk.dim(`Session: ${currentSessionId}\n`));

  let currentMode: 'agent' | 'chat' | 'plan' = 'agent';

  while (true) {
    const stats = agent.getContextStats();
    const statsText = `current memory size : ${stats.tokens} tokens (${formatSize(stats.characters)})`;
    const columns = process.stdout.columns || 80;
    const padding = Math.max(0, columns - statsText.length);
    console.log(chalk.dim(' '.repeat(padding) + statsText));

    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: chalk.green(`(${currentMode}:${currentSessionId}) ❯`),
        prefix: ''
      }
    ]);

    if (!input || input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      config.lastSessionId = currentSessionId;
      await saveConfig(config);
      console.log(chalk.yellow(`\nGoodbye! (Session: ${currentSessionId})`));
      console.log(chalk.dim(`To resume this session, run: tiny-cli --resume ${currentSessionId}\n`));
      process.exit(0);
    }

    if (input.toLowerCase() === '/plan') {
      currentMode = 'plan';
      console.log(chalk.bold.magenta('\nPlan mode ON'));
      console.log(chalk.dim('Research and prepare a task list. No changes will be made.\n'));
      continue;
    }

    if (input.toLowerCase() === '/chat') {
      currentMode = 'chat';
      console.log(chalk.bold.cyan('\nChat mode ON'));
      console.log(chalk.dim('Conversational mode. Tool use is restricted.\n'));
      continue;
    }

    if (input.toLowerCase() === '/agent') {
      currentMode = 'agent';
      console.log(chalk.bold.blue('\nAgent mode ON'));
      console.log(chalk.dim('Autonomous mode. Agent will proactively use tools to solve tasks.\n'));
      continue;
    }

    if (input.toLowerCase() === '/tools') {
      const tools = agent.getToolDefinitions(currentMode);
      console.log(chalk.cyan('\nAvailable Tools:'));
      tools.forEach(tool => {
        console.log(`${chalk.yellow(tool.name)}: ${tool.description}`);
      });
      console.log('');
      continue;
    }

    if (input.toLowerCase().startsWith('/session')) {
      const parts = input.split(' ');
      const command = parts[1];
      const arg = parts[2];

      if (command === 'load' && arg) {
        const newSession = await sessionManager.loadSession(arg);
        if (newSession) {
          session = newSession;
          currentSessionId = arg;
          agent.setHistory(session.messages);
          config.lastSessionId = currentSessionId;
          await saveConfig(config);
          console.log(chalk.green(`\nLoaded session: ${arg}\n`));
        } else {
          console.log(chalk.red(`\nSession not found: ${arg}\n`));
        }
      } else if (command === 'new' && arg) {
        session = SessionManager.createSession(arg);
        currentSessionId = arg;
        agent.setHistory([]);
        config.lastSessionId = currentSessionId;
        await saveConfig(config);
        console.log(chalk.green(`\nStarted new session: ${arg}\n`));
      } else if (command === 'list') {
        const sessions = await sessionManager.listSessions();
        console.log(chalk.cyan('\nSessions:'));
        sessions.forEach(s => {
          console.log(`- ${chalk.yellow(s.id)} (Updated: ${new Date(s.lastUpdatedAt).toLocaleString()})`);
        });
        console.log('');
      } else {
        console.log(chalk.dim('\nUsage: /session [load|new|list] [id]\n'));
      }
      continue;
    }

    if (input.toLowerCase() === '/clear') {
      agent.setHistory([]);
      if (session) {
        session.messages = [];
        await sessionManager.saveSession(session);
      }
      console.log(chalk.yellow('\nConversation history cleared.\n'));
      continue;
    }

    if (input.startsWith('/')) {
      const command = input.split(' ')[0];
      console.log(chalk.red(`\nUnknown command: ${command}`));
      console.log(chalk.cyan('Available commands:'));
      console.log(`${chalk.yellow('/agent')}         - Switch to autonomous agent mode`);
      console.log(`${chalk.yellow('/chat')}          - Switch to conversational chat mode`);
      console.log(`${chalk.yellow('/plan')}          - Switch to planning mode (no changes)`);
      console.log(`${chalk.yellow('/tools')}         - List available tools for current mode`);
      console.log(`${chalk.yellow('/session')}       - Manage sessions (list, load, new)`);
      console.log(`${chalk.yellow('/clear')}         - Clear current conversation history`);
      console.log(`${chalk.yellow('/exit')}          - Exit the application\n`);
      continue;
    }

    const spinner = ora(currentMode === 'plan' ? 'Planning...' : 'Thinking...').start();

    try {
      const response = await agent.run(input, (step: AgentStep) => {
        spinner.stop();
        if (step.toolCall) {
          console.log(chalk.blue(`🔧 Tool: ${step.toolCall.function.name}`));
          console.log(chalk.dim(`Arguments: ${step.toolCall.function.arguments}`));
          if (step.toolResult) {
            console.log(chalk.gray(`Result: ${step.toolResult.slice(0, 100)}${step.toolResult.length > 100 ? '...' : ''}`));
          }
        }
        spinner.start(currentMode === 'plan' ? 'Planning...' : 'Thinking...');
      }, currentMode, true); // Always use continueSession: true in the REPL loop

      spinner.succeed(currentMode === 'plan' ? 'Plan prepared' : 'Task completed');
      console.log(`\n${chalk.blue(response.content)}\n`);

      // Save session
      if (session) {
        session.messages = agent.getHistory();
        session.metadata.lastUpdatedAt = new Date().toISOString();
        await sessionManager.saveSession(session);
      }

      if (currentMode === 'plan') {
        const { savePlan } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'savePlan',
            message: 'Do you want to save this plan as a document?',
            default: false
          }
        ]);

        if (savePlan) {
          const { filename } = await inquirer.prompt([
            {
              type: 'input',
              name: 'filename',
              message: 'Enter filename to save the plan:',
              default: 'implementation_plan.md'
            }
          ]);
          
          try {
            const fs = await import('fs/promises');
            const path = await import('path');
            await fs.writeFile(path.resolve(process.cwd(), filename), response.content, 'utf-8');
            console.log(chalk.green(`\nPlan saved to ${filename}\n`));
          } catch (err: any) {
            console.error(chalk.red(`\nFailed to save plan: ${err.message}\n`));
          }
        }

        const { execute } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'execute',
            message: 'Do you want to execute this plan?',
            default: true
          }
        ]);

        if (execute) {
          const execSpinner = ora('Executing plan...').start();
          try {
            const execResponse = await agent.run(
              "Execute the plan previously prepared.",
              (step: AgentStep) => {
                execSpinner.stop();
                if (step.toolCall) {
                  console.log(chalk.blue(`🔧 Tool: ${step.toolCall.function.name}`));
                  console.log(chalk.dim(`Arguments: ${step.toolCall.function.arguments}`));
                  if (step.toolResult) {
                    console.log(chalk.gray(`Result: ${step.toolResult.slice(0, 100)}${step.toolResult.length > 100 ? '...' : ''}`));
                  }
                }
                execSpinner.start('Executing plan...');
              },
              'agent',
              true
            );
            execSpinner.succeed('Execution completed');
            console.log(`\n${chalk.green(execResponse.content)}\n`);

            // Save session again after execution
            if (session) {
              session.messages = agent.getHistory();
              session.metadata.lastUpdatedAt = new Date().toISOString();
              await sessionManager.saveSession(session);
            }

            // Switch back to chat mode after execution
            currentMode = 'chat';
            console.log(chalk.bold.cyan('Switched to chat mode.\n'));
          } catch (execError: any) {
            execSpinner.fail('Execution failed');
            console.error(chalk.red(execError.message));
          }
        }
      }
    } catch (error: any) {
      spinner.fail('Error occurred');
      console.error(chalk.red(error.message));
    }
  }
}
