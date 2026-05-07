import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import fuzzy from 'fuzzy';
import chalk from 'chalk';
import ora from 'ora';
import { Agent, AgentStep, SessionManager, Session, CommandRegistry } from '@tiny-cli/core';
import { loadConfig, saveConfig } from './config.js';
import { handleModelCommand, handleToolsCommand } from './commands/handlers.js';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

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
  agent.setSessionId(currentSessionId);

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
          
          const planDir = path.join(process.cwd(), '.tiny-cli', currentSessionId, 'plan');
          const planFilePath = path.join(planDir, 'plan.md');
          const currentTaskPath = path.join(planDir, 'current_task.md');
          const allTaskPath = path.join(planDir, 'all_task.md');

          let hasExistingPlan = false;
          try {
            await fs.access(planFilePath);
            await fs.access(currentTaskPath);
            hasExistingPlan = true;
          } catch (e) {}

          if (hasExistingPlan) {
            const { updatePlan } = await inquirer.prompt([
              {
                type: 'list',
                name: 'updatePlan',
                message: 'An existing plan was found. What would you like to do?',
                choices: [
                  { name: 'Update the existing plan', value: true },
                  { name: 'Create a new plan', value: false }
                ]
              }
            ]);

            if (!updatePlan) {
              try {
                const currentTasks = await fs.readFile(currentTaskPath, 'utf-8');
                let allTasks = '';
                try { allTasks = await fs.readFile(allTaskPath, 'utf-8'); } catch (e) {}
                await fs.writeFile(allTaskPath, allTasks + '\n\n' + currentTasks, 'utf-8');

                await fs.unlink(planFilePath);
                await fs.unlink(currentTaskPath);
                console.log(chalk.yellow('Old plan archived. Ready to create a new plan.\n'));
              } catch (e: any) {
                console.log(chalk.red(`Failed to archive old plan: ${e.message}`));
              }
            } else {
              console.log(chalk.blue('Continuing with existing plan. You can ask me to update it.\n'));
            }
          }
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
                  agent.setSessionId(currentSessionId);
                  agent.setHistory(session.messages);
                  console.log(chalk.green(`\nLoaded session: ${id}\n`));
                } else {
                  console.log(chalk.red(`\nSession not found: ${id}\n`));
                }
              } else {
                session = SessionManager.createSession(id);
                currentSessionId = id;
                agent.setSessionId(currentSessionId);
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
      const abortController = new AbortController();
      
      const onKeypress = (str: string | undefined, key: any) => {
        if (key && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
          abortController.abort();
        }
      };

      let wasRaw = false;
      if (process.stdin.isTTY) {
        wasRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        readline.emitKeypressEvents(process.stdin);
        process.stdin.on('keypress', onKeypress);
      }

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
      }, currentMode, true, abortController.signal).finally(() => {
        if (process.stdin.isTTY) {
          process.stdin.removeListener('keypress', onKeypress);
          process.stdin.setRawMode(wasRaw);
        }
      });

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
          let planContent = "";
          let taskContent = "";
          const planDir = path.join(process.cwd(), '.tiny-cli', currentSessionId, 'plan');
          const planFilePath = path.join(planDir, 'plan.md');
          const currentTaskPath = path.join(planDir, 'current_task.md');
          
          try {
            planContent = await fs.readFile(planFilePath, 'utf-8');
          } catch (err) {}
          
          try {
            taskContent = await fs.readFile(currentTaskPath, 'utf-8');
          } catch (err) {}

          // Parse incomplete tasks
          const taskLines = taskContent.split('\n');
          const incompleteTasks: { lineIndex: number, text: string }[] = [];
          for (let i = 0; i < taskLines.length; i++) {
            if (taskLines[i].trim().match(/^- \[\s\]/)) {
              incompleteTasks.push({ lineIndex: i, text: taskLines[i].trim() });
            }
          }

          if (incompleteTasks.length > 0) {
            console.log(chalk.cyan(`\nFound ${incompleteTasks.length} pending tasks to execute.`));
            
            let abortExecution = false;
            for (let i = 0; i < incompleteTasks.length; i++) {
              if (abortExecution) break;
              
              const task = incompleteTasks[i];
              console.log(chalk.bold.yellow(`\n[Executing Task ${i + 1}/${incompleteTasks.length}] ${task.text}`));
              
              const execSpinner = ora(`Executing task...`).start();
              
              const prompt = `You are in execution mode. 

Your CURRENT task to implement is EXACTLY:
--------------------------------------------------
${task.text}
--------------------------------------------------

The overall project plan is provided below for CONTEXT ONLY. 
DO NOT implement any other tasks from the overall plan right now. 
Once you have completed the CURRENT task, you MUST STOP and return a success message. Do not proceed to the next step of the project.

Overall Plan Context:
${planContent}`;
              
              const abortController = new AbortController();
              const onKeypress = (str: string | undefined, key: any) => {
                if (key && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
                  abortController.abort();
                  abortExecution = true;
                }
              };

              let wasRaw = false;
              if (process.stdin.isTTY) {
                wasRaw = process.stdin.isRaw;
                process.stdin.setRawMode(true);
                readline.emitKeypressEvents(process.stdin);
                process.stdin.on('keypress', onKeypress);
              }

              try {
                const execResponse = await agent.run(
                  prompt,
                  (step: AgentStep) => {
                    execSpinner.stop();
                    if (step.toolCall) {
                      console.log(chalk.blue(`🔧 Tool: ${step.toolCall.function.name}`));
                      console.log(chalk.dim(`Arguments: ${step.toolCall.function.arguments}`));
                      if (step.toolResult) {
                        console.log(chalk.gray(`Result: ${step.toolResult.slice(0, 100)}${step.toolResult.length > 100 ? '...' : ''}`));
                      }
                    }
                    execSpinner.start(`Executing task ${i+1}/${incompleteTasks.length}...`);
                  },
                  'agent',
                  true,
                  abortController.signal
                ).finally(() => {
                  if (process.stdin.isTTY) {
                    process.stdin.removeListener('keypress', onKeypress);
                    process.stdin.setRawMode(wasRaw);
                  }
                });

                execSpinner.succeed(`Task ${i + 1} completed`);
                console.log(`\n${chalk.green(execResponse.content)}\n`);

                if (!abortController.signal.aborted) {
                   // Update task file
                   taskLines[task.lineIndex] = task.text.replace(/^- \[\s\]/, '- [x]');
                   await fs.writeFile(currentTaskPath, taskLines.join('\n'), 'utf-8');
                   console.log(chalk.dim(`Marked task as completed in current_task.md`));
                }

                if (session) {
                  session.messages = agent.getHistory();
                  session.metadata.lastUpdatedAt = new Date().toISOString();
                  await sessionManager.saveSession(session);
                }
              } catch (execError: any) {
                execSpinner.fail('Execution failed');
                console.error(chalk.red(execError.message));
                abortExecution = true; // Stop subsequent tasks
              }
            }
            
            currentMode = 'agent';
            console.log(chalk.bold.blue('\nSwitched to agent mode.\n'));
          } else {
            const execSpinner = ora('Executing plan...').start();
            try {
              const prompt = planContent 
                ? `You are now in execution mode. Your task is to IMPLEMENT the following plan step-by-step. Do not just save this document. You must write the actual code, create the necessary files, and run the required commands to complete all the tasks described in the plan.\n\nHere is the plan:\n\n${planContent}`
                : "You are now in execution mode. Execute the plan previously prepared by writing the actual code and completing the tasks.";
              
              const abortController = new AbortController();
              
              const onKeypress = (str: string | undefined, key: any) => {
                if (key && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
                  abortController.abort();
                }
              };

              let wasRaw = false;
              if (process.stdin.isTTY) {
                wasRaw = process.stdin.isRaw;
                process.stdin.setRawMode(true);
                readline.emitKeypressEvents(process.stdin);
                process.stdin.on('keypress', onKeypress);
              }

              const execResponse = await agent.run(
                prompt,
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
                true,
                abortController.signal
              ).finally(() => {
                if (process.stdin.isTTY) {
                  process.stdin.removeListener('keypress', onKeypress);
                  process.stdin.setRawMode(wasRaw);
                }
              });
              execSpinner.succeed('Execution completed');
              console.log(`\n${chalk.green(execResponse.content)}\n`);

              if (session) {
                session.messages = agent.getHistory();
                session.metadata.lastUpdatedAt = new Date().toISOString();
                await sessionManager.saveSession(session);
              }
              currentMode = 'agent';
              console.log(chalk.bold.blue('Switched to agent mode.\n'));
            } catch (execError: any) {
              execSpinner.fail('Execution failed');
              console.error(chalk.red(execError.message));
            }
          }
        }
      }
    } catch (error: any) {
      spinner.fail('Error occurred');
      console.error(chalk.red(error.message));
    }
  }
}
