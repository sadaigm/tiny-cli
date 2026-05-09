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

// Register autocomplete prompt
inquirer.registerPrompt('autocomplete', autocompletePrompt);

// Deep monkey-patch to ensure absolute silence and correct command selection
// @ts-ignore
const originalRender = autocompletePrompt.prototype.render;
// @ts-ignore
autocompletePrompt.prototype.render = function (error) {
  const self = this as any;
  self.firstRender = false;
  if (self.status === 'answered') {
    self.screen.done();
    return;
  }
  if (self.opt.suggestOnly && !self.rl.line.startsWith('/')) {
    self.screen.render(self.getQuestion() + self.rl.line, '');
    return;
  }
  return originalRender.call(this, error);
};

// @ts-ignore
const originalOnSubmit = autocompletePrompt.prototype.onSubmit;
// @ts-ignore
autocompletePrompt.prototype.onSubmit = function (line) {
  const self = this as any;
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function startRepl(resumeId?: string) {
  const config = await loadConfig();
  const agent = new Agent(config);
  const sessionManager = new SessionManager();
  const commandRegistry = new CommandRegistry();

  // Register built-in commands
  commandRegistry.register({ name: 'agent', description: 'Switch to autonomous agent mode' });
  commandRegistry.register({ name: 'chat', description: 'Switch to conversational chat mode' });
  commandRegistry.register({ name: 'plan', description: 'Switch to planning mode' });
  commandRegistry.register({ name: 'model', description: 'Select a different LLM model', hasSubOptions: true });
  commandRegistry.register({ name: 'tools', description: 'List available tools', hasSubOptions: true });
  commandRegistry.register({ name: 'session', description: 'Manage sessions', hasSubOptions: true });
  commandRegistry.register({ name: 'clear', description: 'Clear history' });
  commandRegistry.register({ name: 'exit', description: 'Exit the application' });
  commandRegistry.register({ name: 'continue', description: 'Continue with the active plan' });

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

  // Helper to execute tasks from the current plan
  async function executeActivePlan() {
    const planDir = path.join(process.cwd(), '.tiny-cli', currentSessionId, 'plan');
    const planFilePath = path.join(planDir, 'plan.md');
    const currentTaskPath = path.join(planDir, 'current_task.md');
    
    let planContent = "";
    let taskContent = "";
    try { planContent = await fs.readFile(planFilePath, 'utf-8'); } catch (err) {}
    try { taskContent = await fs.readFile(currentTaskPath, 'utf-8'); } catch (err) {}

    const taskLines = taskContent.split('\n');
    const incompleteTasks: { lineIndex: number, text: string }[] = [];
    for (let i = 0; i < taskLines.length; i++) {
      if (taskLines[i].trim().match(/^- \[\s\]/)) {
        incompleteTasks.push({ lineIndex: i, text: taskLines[i].trim() });
      }
    }

    if (incompleteTasks.length === 0) {
      console.log(chalk.yellow('\nNo incomplete tasks found in the plan.\n'));
      return;
    }

    console.log(chalk.cyan(`\nFound ${incompleteTasks.length} pending tasks to execute.`));
    let abortExecution = false;
    
    for (let i = 0; i < incompleteTasks.length; i++) {
      if (abortExecution) break;
      const task = incompleteTasks[i];
      console.log(chalk.bold.yellow(`\n[Executing Task ${i + 1}/${incompleteTasks.length}] ${task.text}`));
      
      const stats = agent.getContextStats();
      const statsText = `current memory size : ${stats.tokens} tokens (${formatSize(stats.characters)})`;
      console.log(chalk.dim(' '.repeat(Math.max(0, (process.stdout.columns || 80) - statsText.length)) + statsText));

      const execSpinner = ora(`Executing task...`).start();
      const prompt = `You are in execution mode. 

Your CURRENT task to implement is EXACTLY:
${task.text}

Plan Context:
${planContent}`;
      
      const abortController = new AbortController();
      const onKeypress = (str: any, key: any) => {
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
        const execResponse = await agent.run(prompt, (step) => {
          execSpinner.stop();
          if (step.toolCall) {
            const timing = step.timing?.toolCallMs ? chalk.dim(` [${Math.round(step.timing.toolCallMs)}ms]`) : '';
            console.log(chalk.blue(`🔧 Tool: ${step.toolCall.function.name}${timing}`));
            console.log(chalk.dim(`Arguments: ${step.toolCall.function.arguments}`));
          }
          const aiTiming = step.timing?.modelChatMs ? chalk.dim(` [AI: ${(step.timing.modelChatMs / 1000).toFixed(1)}s]`) : '';
          execSpinner.start(`Executing task ${i+1}/${incompleteTasks.length}...` + aiTiming);
        }, 'agent', true, abortController.signal);

        execSpinner.succeed(`Task ${i + 1} completed`);
        console.log(`\n${chalk.green(execResponse.content)}\n`);

        if (!abortController.signal.aborted) {
          taskLines[task.lineIndex] = task.text.replace(/^- \[\s\]/, '- [x]');
          await fs.writeFile(currentTaskPath, taskLines.join('\n'), 'utf-8');
        }
        
        if (session) {
          session.messages = agent.getHistory();
          await sessionManager.saveSession(session);
        }
      } catch (err: any) {
        execSpinner.fail(`Execution failed: ${err.message}`);
        abortExecution = true;
      } finally {
        if (process.stdin.isTTY) {
          process.stdin.removeListener('keypress', onKeypress);
          process.stdin.setRawMode(wasRaw);
        }
      }
    }
  }

  while (true) {
    // Check for Plan Execution Resumption
    if ((global as any).resumeExecution) {
      (global as any).resumeExecution = false;
      await executeActivePlan();
      currentMode = 'agent';
      console.log(chalk.bold.blue('Switched to agent mode.\n'));
      continue;
    }

    const stats = agent.getContextStats();
    const statsText = `current memory size : ${stats.tokens} tokens (${formatSize(stats.characters)})`;
    const columns = process.stdout.columns || 80;
    console.log(chalk.dim(' '.repeat(Math.max(0, columns - statsText.length)) + statsText));

    const { selection } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'selection',
        message: chalk.green(`(${currentMode}) ❯`),
        prefix: '',
        suggestOnly: true,
        source: (_answers: any, input: string) => {
          input = input || '';
          const commands = commandRegistry.getAllCommands();
          if (input.startsWith('/')) {
            const search = input.slice(1);
            return fuzzy.filter(search, commands.map(c => '/' + c.name)).map(el => el.original);
          }
          return [];
        }
      }
    ]);

    let input = selection.trim();
    if (!input) continue;

    if (input.startsWith('/')) {
      const commandName = input.slice(1);
      const command = commandRegistry.getCommand(commandName);

      if (command) {
        if (commandName === 'exit' || commandName === 'quit') {
          config.lastSessionId = currentSessionId;
          await saveConfig(config);
          process.exit(0);
        }
        if (commandName === 'agent') { currentMode = 'agent'; continue; }
        if (commandName === 'chat') { currentMode = 'chat'; continue; }
        if (commandName === 'plan') { currentMode = 'plan'; continue; }
        if (commandName === 'continue') { (global as any).resumeExecution = true; continue; }
        if (commandName === 'clear') { 
          agent.setHistory([]); 
          if (session) { session.messages = []; await sessionManager.saveSession(session); }
          continue; 
        }
        if (commandName === 'model') { await handleModelCommand(agent); continue; }
        if (commandName === 'tools') { await handleToolsCommand(agent, currentMode); continue; }
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
      }
    } else {
      if (input.toLowerCase() === 'continue' && currentMode === 'agent') {
        (global as any).resumeExecution = true;
        continue;
      }
    }

    const spinner = ora(currentMode === 'plan' ? 'Planning...' : 'Thinking...').start();
    try {
      const abortController = new AbortController();
      const onKeypress = (str: any, key: any) => {
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
          const timing = step.timing?.toolCallMs ? chalk.dim(` [${Math.round(step.timing.toolCallMs)}ms]`) : '';
          console.log(chalk.blue(`🔧 Tool: ${step.toolCall.function.name}${timing}`));
          console.log(chalk.dim(`Arguments: ${step.toolCall.function.arguments}`));
          if (step.toolResult) {
            console.log(chalk.gray(`Result: ${step.toolResult.slice(0, 100)}${step.toolResult.length > 100 ? '...' : ''}`));
          }
        }
        const aiTiming = step.timing?.modelChatMs ? chalk.dim(` [AI: ${(step.timing.modelChatMs / 1000).toFixed(1)}s]`) : '';
        spinner.start((currentMode === 'plan' ? 'Planning...' : 'Thinking...') + aiTiming);
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
        await sessionManager.saveSession(session);
      }

      if (currentMode === 'plan') {
        const { execute } = await inquirer.prompt([
          { type: 'confirm', name: 'execute', message: 'Execute this plan?', default: true }
        ]);
        if (execute) (global as any).resumeExecution = true;
      }
    } catch (err: any) {
      spinner.fail(`Error: ${err.message}`);
    }
  }
}
