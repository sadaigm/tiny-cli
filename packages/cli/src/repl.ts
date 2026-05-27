import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import fuzzy from 'fuzzy';
import chalk from 'chalk';
import ora from 'ora';
import { Agent, AgentStep, SessionManager, Session, CommandRegistry, setLogLevel, logTrace, logDebug, logError } from '@tiny-cli/core';
import { loadConfig, saveConfig } from './config.js';
import { handleModelCommand, handleToolsCommand } from './commands/handlers.js';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { buildFileIndex, searchFiles, hydrateMessage } from './file-mention.js';

// Register autocomplete prompt
inquirer.registerPrompt('autocomplete', autocompletePrompt);

// Deep monkey-patch to ensure absolute silence and correct command selection
// @ts-ignore
const originalRender = autocompletePrompt.prototype.render;
// @ts-ignore
autocompletePrompt.prototype.render = function (error) {
  const self = this as any;
  self.firstRender = false;

  // Ensure Ctrl+D exits correctly
  if (self.rl && !self.rl._exitHandlerAdded) {
    self.rl.input.on('keypress', (_str: string, key: any) => {
      if (key && key.ctrl && key.name === 'd' && !self.rl.line) {
        process.exit(0);
      }
    });
    self.rl._exitHandlerAdded = true;
  }

  if (self.status === 'answered') {
    self.screen.done();
    return;
  }
  // Allow @mention picker to render even if suggestOnly is true and line doesn't start with /
  const isAtMention = self.rl.line.match(/@(\S*)$/);
  if (self.opt.suggestOnly && !self.rl.line.startsWith('/') && !isAtMention) {
    self.screen.render(self.getQuestion() + self.rl.line, '');
    return;
  }
  return originalRender.call(this, error);
};

// @ts-ignore
const originalOnSubmit = autocompletePrompt.prototype.onSubmit;
// @ts-ignore
autocompletePrompt.prototype.onSubmit = function (line) {
  if (line === undefined) {
    return originalOnSubmit.call(this, line);
  }
  const self = this as any;
  const currentLine = line || self.rl.line || '';
  
  // Case 1: Slash command selection
  if (self.opt.suggestOnly && currentLine.startsWith('/') && self.nbChoices > 0) {
    const choice = self.currentChoices.getChoice(self.selected);
    if (choice && choice.value) {
      self.rl.line = choice.value;
      line = choice.value;
    }
    return originalOnSubmit.call(this, line);
  }

  // Case 2: @mention selection - pick file, keep composing
  const atMatch = currentLine.match(/@(\S*)$/);
  if (self.opt.suggestOnly && atMatch && self.nbChoices > 0) {
    const choice = self.currentChoices.getChoice(self.selected);
    if (choice && choice.value) {
      const newLine = currentLine.slice(0, atMatch.index) + `[@${choice.value}] `;
      self.rl.line = newLine;
      self.rl.cursor = newLine.length;
      // Reset picker state
      self.search(newLine); 
      self.render();
      return; // Do NOT submit the prompt
    }
  }

  return originalOnSubmit.call(this, line);
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function startRepl(resumeId?: string, initialMode: 'agent' | 'chat' | 'plan' = 'agent') {
  logTrace('startRepl called');
  logTrace(`stdin.isTTY: ${process.stdin.isTTY}, stdout.isTTY: ${process.stdout.isTTY}`);

  logTrace('Loading config...');
  const config = await loadConfig();
  if (config.logLevel) setLogLevel(config.logLevel);
  logTrace(`Config loaded: endpoint=${config.endpoint}, model=${config.model}, logLevel=${config.logLevel || 'LOG'}`);

  logTrace('Creating Agent...');
  const agent = new Agent(config);
  logTrace('Agent created');

  logTrace('Initializing agent (MCP connecting in background)...');
  await agent.init();
  logTrace('Agent initialized (MCP servers connecting in background)');

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
  commandRegistry.register({ name: 'mcp', description: 'Manage MCP servers', hasSubOptions: true });
  commandRegistry.register({ name: 'exit', description: 'Exit the application' });
  commandRegistry.register({ name: 'continue', description: 'Continue with the active plan' });
  commandRegistry.register({ name: 'mode', description: 'Switch permission mode (notify, auto-edit, auto)' });

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
  
  // Resolve active permission mode (Session > Config > Default)
  config.permissionMode = session.metadata.permissionMode || config.permissionMode || 'notify';

  logTrace(`Session setup complete: id=${currentSessionId}`);

  console.log(chalk.bold.cyan('\n🚀 tiny-cli Agent Ready'));
  console.log(chalk.dim(`Model: ${config.model} @ ${config.endpoint}`));
  console.log(chalk.dim(`Session: ${currentSessionId}\n`));

  let currentMode: 'agent' | 'chat' | 'plan' = initialMode;

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

      const prompt = `You are in execution mode. 
Your goal is to implement the task described below.

Your CURRENT task to implement is EXACTLY:
${task.text}

Plan Context:
${planContent}

CRITICAL INSTRUCTIONS:
1. When you have successfully implemented and verified the task, you MUST call the 'mark_task_complete' tool.
2. If you do not call 'mark_task_complete', the task will be marked as FAILED or INCOMPLETE.
3. Only call 'mark_task_complete' if the code is actually written and tested.`;
      
      const execSpinner = ora(`Executing task ${i+1}/${incompleteTasks.length}...`).start();
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
        const onApproval = async (call: any) => {
          execSpinner.stop();
          console.log(chalk.yellow(`\n⚠️  Tool Approval Required`));
          console.log(chalk.blue(`🔧 Tool: ${call.function.name}`));
          console.log(chalk.dim(`Arguments: ${call.function.arguments}`));
          
          let approved;
          try {
            const response = await inquirer.prompt([
              {
                type: 'list',
                name: 'approved',
                message: 'Approve this tool execution?',
                choices: [
                  { name: 'Approve (Run)', value: 'yes' },
                  { name: 'Approve (Session)', value: 'session' },
                  { name: 'Skip (Cancel)', value: 'no' },
                  { name: 'Abort Session', value: 'abort' }
                ]
              }
            ]);
            approved = response.approved;
          } catch (e) {
            abortController.abort();
            abortExecution = true;
            return false;
          }
          
          if (approved === 'abort') {
            abortController.abort();
            abortExecution = true;
            return false;
          }
          
          if (approved === 'session') {
            config.permissionMode = 'auto';
            if (session) {
              session.metadata.permissionMode = 'auto';
              await sessionManager.saveSession(session);
            }
            execSpinner.start(`Executing task ${i+1}/${incompleteTasks.length}...`);
            return true;
          }
          
          execSpinner.start(`Executing task ${i+1}/${incompleteTasks.length}...`);
          return approved === 'yes';
        };

        const execResponse = await agent.run(prompt, (step) => {
          execSpinner.stop();
          if (step.toolCall) {
            const timing = step.timing?.toolCallMs ? chalk.dim(` [${Math.round(step.timing.toolCallMs)}ms]`) : '';
            console.log(chalk.blue(`🔧 Tool: ${step.toolCall.function.name}${timing}`));
            console.log(chalk.dim(`Arguments: ${step.toolCall.function.arguments}`));
          }
          const aiTiming = step.timing?.modelChatMs ? chalk.dim(` [AI: ${(step.timing.modelChatMs / 1000).toFixed(1)}s]`) : '';
          execSpinner.start(`Executing task ${i+1}/${incompleteTasks.length}...` + aiTiming);
        }, 'agent', true, abortController.signal, onApproval);

        // Verify if task was marked done
        const updatedTaskContent = await fs.readFile(currentTaskPath, 'utf-8');
        const updatedLines = updatedTaskContent.split('\n');
        const isActuallyMarked = updatedLines.some(line => line.includes(task.text.replace(/^- \[\s\]/, '')) && line.includes('[x]'));

        if (isActuallyMarked) {
          execSpinner.succeed(`Task ${i + 1} completed`);
        } else {
          execSpinner.warn(`Task ${i + 1} finished turn but was NOT marked as complete by agent.`);
          const { action } = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: 'What should we do?',
              choices: [
                { name: 'Retry task execution', value: 'retry' },
                { name: 'Mark as done manually and continue', value: 'manual' },
                { name: 'Skip for now', value: 'skip' },
                { name: 'Stop execution', value: 'stop' }
              ]
            }
          ]);

          if (action === 'retry') {
            i--; // Repeat this task
            continue;
          } else if (action === 'manual') {
            updatedLines[task.lineIndex] = task.text.replace(/^- \[\s\]/, '- [x]');
            await fs.writeFile(currentTaskPath, updatedLines.join('\n'), 'utf-8');
            execSpinner.succeed(`Task ${i + 1} marked as done manually`);
          } else if (action === 'skip') {
            // Do nothing, moves to next task
          } else {
            abortExecution = true;
          }
        }

        console.log(`\n${chalk.green(execResponse.content)}\n`);

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
    logTrace('=== REPL loop start ===');

    logDebug('Building file index...');
    const fileIndex = await buildFileIndex(process.cwd());
    logDebug(`File index built: ${fileIndex.length} files`);

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

    let selection;
    try {
      logTrace('Showing inquirer prompt...');
      const response = await inquirer.prompt([
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
            const atMatch = input.match(/@(\S*)$/);
            if (atMatch) {
              // Re-fetch index inside source to ensure it's fresh if needed, 
              // but for now the loop-level refresh is enough.
              return searchFiles(fileIndex, atMatch[1]);
            }
            return [];
          }
        }
      ]);
      selection = response.selection;
      logTrace(`User input received: "${selection}"`);

      // Flush MCP background connection logs after prompt resolves
      const mcpLogs = agent.mcpManager.flushLogs();
      for (const log of mcpLogs) {
        console.log(log.startsWith('✅') ? chalk.green(log) : chalk.red(log));
      }
    } catch (e) {
      // Handle Ctrl+C or other prompt interruptions
      await agent.destroy();
      process.exit(0);
    }

    if (selection === undefined || selection === null) {
      await agent.destroy();
      process.exit(0);
    }

    let input = selection.trim();
    if (!input) continue;

    if (input.startsWith('/')) {
      const parts = input.slice(1).split(' ');
      const commandName = parts[0].toLowerCase();

      if (commandName === 'exit' || commandName === 'quit') {
        config.lastSessionId = currentSessionId;
        await saveConfig(config);
        await agent.destroy();
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
      if (commandName === 'mode') {
        const { mode } = await inquirer.prompt([
          {
            type: 'list',
            name: 'mode',
            message: 'Select Permission Mode:',
            choices: [
              { name: 'Notify (Always ask for modifying tools)', value: 'notify' },
              { name: 'Auto-Edit (Auto-edit files, ask for bash)', value: 'auto-edit' },
              { name: 'Auto (No prompts)', value: 'auto' }
            ],
            default: agent.getConfig().permissionMode || 'notify'
          }
        ]);
        config.permissionMode = mode;
        if (session) {
          session.metadata.permissionMode = mode;
          await sessionManager.saveSession(session);
        }
        console.log(chalk.green(`\nPermission mode set to: ${mode}\n`));
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
      if (commandName === 'mcp') {
        const servers = config.mcpServers || [];
        if (servers.length === 0) {
          console.log(chalk.yellow('\nNo MCP servers configured in agents.json\n'));
          continue;
        }

        const { serverName } = await inquirer.prompt([
          {
            type: 'list',
            name: 'serverName',
            message: 'Select MCP Server:',
            choices: servers.map(s => ({
              name: `${s.name} [${s.type}] (${agent.mcpManager.getStatus(s.name)})`,
              value: s.name
            })).concat([{ name: 'Cancel', value: 'cancel' }])
          }
        ]);

        if (serverName === 'cancel') continue;

        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: `Action for ${serverName}:`,
            choices: [
              { name: '1. Reconnect', value: 'reconnect' },
              { name: '2. Disconnect', value: 'disconnect' },
              { name: '3. List tools', value: 'list' },
              { name: 'Cancel', value: 'cancel' }
            ]
          }
        ]);

        if (action === 'reconnect') {
          const srv = servers.find(s => s.name === serverName);
          if (srv) {
            const spin = ora(`Reconnecting to ${serverName}...`).start();
            try {
              await agent.mcpManager.reconnect(srv);
              spin.succeed(`Reconnected to ${serverName}`);
            } catch (e: any) {
              spin.fail(`Failed to reconnect: ${e.message}`);
            }
          }
        } else if (action === 'disconnect') {
          const spin = ora(`Disconnecting ${serverName}...`).start();
          await agent.mcpManager.disconnect(serverName);
          spin.succeed(`Disconnected ${serverName}`);
        } else if (action === 'list') {
          const tools = agent.mcpManager.getTools(serverName);
          console.log(chalk.cyan(`\nTools for ${serverName}:`));
          if (tools.length === 0) {
            console.log(chalk.dim('  No tools found or server disconnected.'));
          } else {
            tools.forEach(t => {
              console.log(`${chalk.yellow(t.definition.name)}`);
              if (t.definition.description) {
                const descLines = t.definition.description.split('\n');
                if (descLines.length > 3) {
                  console.log(chalk.dim(`  ${descLines.slice(0, 3).join('\n  ')}...`));
                } else {
                  console.log(chalk.dim(`  ${t.definition.description}`));
                }
              }
            });
          }
          console.log('');
        }
        continue;
      }
      
      console.log(chalk.red(`\nUnknown command: ${input}\n`));
      continue;
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

      const hydratedInput = await hydrateMessage(input);
      
      const onApproval = async (call: any) => {
        spinner.stop();
        console.log(chalk.yellow(`\n⚠️  Tool Approval Required`));
        console.log(chalk.blue(`🔧 Tool: ${call.function.name}`));
        console.log(chalk.dim(`Arguments: ${call.function.arguments}`));
        
        let approved;
        try {
          const response = await inquirer.prompt([
            {
              type: 'list',
              name: 'approved',
              message: 'Approve this tool execution?',
              choices: [
                { name: 'Approve (Run)', value: 'yes' },
                { name: 'Approve (Session)', value: 'session' },
                { name: 'Skip (Cancel)', value: 'no' },
                { name: 'Abort Session', value: 'abort' }
              ]
            }
          ]);
          approved = response.approved;
        } catch (e) {
          abortController.abort();
          return false;
        }
        
        if (approved === 'abort') {
          abortController.abort();
          return false;
        }
        
        if (approved === 'session') {
          config.permissionMode = 'auto';
          if (session) {
            session.metadata.permissionMode = 'auto';
            await sessionManager.saveSession(session);
          }
          spinner.start(currentMode === 'plan' ? 'Planning...' : 'Thinking...');
          return true;
        }
        
        spinner.start(currentMode === 'plan' ? 'Planning...' : 'Thinking...');
        return approved === 'yes';
      };

      const response = await agent.run(hydratedInput, (step: AgentStep) => {
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
      }, currentMode, true, abortController.signal, onApproval).finally(() => {
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
