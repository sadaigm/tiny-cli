import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import fuzzy from 'fuzzy';
import chalk from 'chalk';
import ora from 'ora';
import { Agent, AgentStep, SessionManager, Session, CommandRegistry } from '@tiny-cli/core';
import { loadConfig, saveConfig } from './config.js';
import { handleModelCommand, handleToolsCommand } from './commands/handlers.js';

// Deep monkey-patch to ensure absolute silence and correct command selection
// @ts-ignore
const originalRender = autocompletePrompt.prototype.render;
// @ts-ignore
autocompletePrompt.prototype.render = function(error) {
  const self = this as any;
  self.firstRender = false;
  if (self.status === 'answered') {
    self.screen.done();
    return;
  }
  // ONLY hide suggestions for the main REPL prompt (suggestOnly: true)
  // when not starting with a slash command.
  if (self.opt.suggestOnly && !self.rl.line.startsWith('/')) {
    self.screen.render(self.getQuestion() + self.rl.line, '');
    return;
  }
  return originalRender.call(this, error);
};

// @ts-ignore
const originalOnSubmit = autocompletePrompt.prototype.onSubmit;
// @ts-ignore
autocompletePrompt.prototype.onSubmit = function(line) {
  const self = this as any;
  
  // If user is typing a command in the main prompt (suggestOnly: true) and hits Enter, 
  // pick the selected suggestion automatically
  const currentLine = line || self.rl.line || '';
  if (self.opt.suggestOnly && currentLine.startsWith('/') && self.nbChoices > 0) {
    const choice = self.currentChoices.getChoice(self.selected);
    if (choice && choice.value) {
      self.rl.line = choice.value;
      line = choice.value;
    }
  }
  return originalOnSubmit.call(this, line);
};

// Register autocomplete prompt
inquirer.registerPrompt('autocomplete', autocompletePrompt);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 5)}...${id.slice(-5)}`;
}

export async function startRepl(resumeId?: string) {
  const config = await loadConfig();
  const agent = new Agent(config);
  const sessionManager = new SessionManager();
  const commandRegistry = new CommandRegistry();

  // Register built-in commands
  commandRegistry.register({ name: 'agent', description: 'Switch to autonomous agent mode' });
  commandRegistry.register({ name: 'chat', description: 'Switch to conversational chat mode' });
  commandRegistry.register({ name: 'plan', description: 'Switch to planning mode (no changes)' });
  commandRegistry.register({ name: 'model', description: 'Select a different LLM model', hasSubOptions: true });
  commandRegistry.register({ name: 'tools', description: 'List available tools for current mode', hasSubOptions: true });
  commandRegistry.register({ name: 'session', description: 'Manage sessions (list, load, new)', hasSubOptions: true });
  commandRegistry.register({ name: 'clear', description: 'Clear current conversation history' });
  commandRegistry.register({ name: 'exit', description: 'Exit the application' });

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

    const { selection } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'selection',
        message: chalk.green(`(${currentMode}) ❯`),
        prefix: '',
        suggestOnly: true,
        searchText: '',
        emptyText: '',
        source: (_answers: any, input: string) => {
          input = input || '';
          const commands = commandRegistry.getAllCommands();
          
          if (input.startsWith('/')) {
            const search = input.slice(1);
            return fuzzy.filter(search, commands.map(c => '/' + c.name)).map(el => el.original);
          } else {
            return [];
          }
        }
      }
    ]);

    let input = selection.trim();
    if (!input) continue;

    // Handle Slash Commands
    if (input.startsWith('/')) {
      const commandName = input.slice(1);
      const command = commandRegistry.getCommand(commandName);

      if (command) {
        if (commandName === 'exit' || commandName === 'quit') {
          config.lastSessionId = currentSessionId;
          await saveConfig(config);
          console.log(chalk.yellow(`\nGoodbye! (Session: ${currentSessionId})`));
          process.exit(0);
        }

        if (commandName === 'agent') {
          currentMode = 'agent';
          console.log(chalk.bold.blue('\nAgent mode ON'));
          console.log(chalk.dim('Autonomous mode. Agent will proactively use tools to solve tasks.\n'));
          continue;
        }

        if (commandName === 'chat') {
          currentMode = 'chat';
          console.log(chalk.bold.cyan('\nChat mode ON'));
          console.log(chalk.dim('Conversational mode. Tool use is restricted.\n'));
          continue;
        }

        if (commandName === 'plan') {
          currentMode = 'plan';
          console.log(chalk.bold.magenta('\nPlan mode ON'));
          console.log(chalk.dim('Research and prepare a task list. No changes will be made.\n'));
          continue;
        }

        if (commandName === 'clear') {
          agent.setHistory([]);
          if (session) {
            session.messages = [];
            await sessionManager.saveSession(session);
          }
          console.log(chalk.yellow('\nConversation history cleared.\n'));
          continue;
        }

        if (commandName === 'model') {
          await handleModelCommand(agent);
          continue;
        }

        if (commandName === 'tools') {
          await handleToolsCommand(agent, currentMode);
          continue;
        }

        if (commandName === 'session') {
          const { action } = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: 'Session Action:',
              choices: ['list', 'load', 'new', 'cancel']
            }
          ]);

          if (action === 'list') {
            const sessions = await sessionManager.listSessions();
            console.log(chalk.cyan('\nSessions:'));
            sessions.forEach(s => {
              console.log(`- ${chalk.yellow(s.id)} (Updated: ${new Date(s.lastUpdatedAt).toLocaleString()})`);
            });
            console.log('');
          } else if (action === 'load' || action === 'new') {
            const { id } = await inquirer.prompt([{ type: 'input', name: 'id', message: `Enter session ID to ${action}:` }]);
            if (id) {
              if (action === 'load') {
                const newSession = await sessionManager.loadSession(id);
                if (newSession) {
                  session = newSession;
                  currentSessionId = id;
                  agent.setHistory(session.messages);
                  console.log(chalk.green(`\nLoaded session: ${id}\n`));
                } else {
                  console.log(chalk.red(`\nSession not found: ${id}\n`));
                }
              } else {
                session = SessionManager.createSession(id);
                currentSessionId = id;
                agent.setHistory([]);
                console.log(chalk.green(`\nStarted new session: ${id}\n`));
              }
              config.lastSessionId = currentSessionId;
              await saveConfig(config);
            }
          }
          continue;
        }
      } else {
        console.log(chalk.red(`\nUnknown command: ${input}`));
        continue;
      }
    }

    // Standard Chat Execution
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
      }, currentMode, true);

      spinner.succeed(currentMode === 'plan' ? 'Plan prepared' : 'Task completed');
      console.log(`\n${chalk.blue(response.content)}\n`);

      if (session) {
        session.messages = agent.getHistory();
        session.metadata.lastUpdatedAt = new Date().toISOString();
        await sessionManager.saveSession(session);
      }

      if (currentMode === 'plan') {
        const { execute } = await inquirer.prompt([
          { type: 'confirm', name: 'execute', message: 'Do you want to execute this plan?', default: true }
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

            if (session) {
              session.messages = agent.getHistory();
              session.metadata.lastUpdatedAt = new Date().toISOString();
              await sessionManager.saveSession(session);
            }
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
