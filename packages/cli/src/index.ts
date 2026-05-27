#!/usr/bin/env node
import { Command } from 'commander';
import { startRepl } from './repl.js';
import { Agent, AgentStep, SessionManager, logDebug } from '@tiny-cli/core';
import { loadConfig } from './config.js';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';

const program = new Command();

program
  .name('tiny-cli')
  .description('A workflow-driven CLI agent powered by small local models')
  .version('1.0.0')
  .option('-r, --resume <id>', 'Resume a specific session by ID')
  .option('-q, --query <text>', 'Explicitly pass a query to execute and exit')
  .option('-m, --mode <type>', 'Execution mode (agent, plan)', 'agent')
  .argument('[query...]', 'The question or task for the agent')
  .addHelpText('after', `
Examples:
  $ tiny-cli                                     # Starts the interactive REPL
  $ tiny-cli --mode plan                         # Starts the REPL in plan mode
  $ tiny-cli "build a web app"                   # Headless execution in agent mode
  $ tiny-cli -q "draft an architecture" -m plan  # Headless execution in plan mode
`)
  .action(async (queryParts, options) => {
    const positionalQuery = queryParts.join(' ');
    const query = options.query || positionalQuery;

    if (!query) {
      logDebug(`No query provided, starting REPL... stdin.isTTY: ${process.stdin.isTTY}`);
      // No query provided, start interactive REPL
      await startRepl(options.resume, options.mode);
    } else {
      // Single task execution
      const config = await loadConfig();

      // Enforce auto for headless by default if notify is set
      if (!config.permissionMode || config.permissionMode === 'notify') {
        console.log(chalk.yellow('⚠️  Headless execution does not support "notify" mode. Overriding to "auto".'));
        config.permissionMode = 'auto';
      }

      const agent = new Agent(config);
      await agent.init();
      const sessionManager = new SessionManager();

      // Load or create session
      let currentSessionId = options.resume || SessionManager.createSession().metadata.id;
      let session = await sessionManager.loadSession(currentSessionId);

      if (session) {
        agent.setHistory(session.messages);
      } else {
        session = SessionManager.createSession(currentSessionId);
      }

      agent.setSessionId(currentSessionId);

      console.log(chalk.dim(`Session: ${currentSessionId}`));
      const spinner = ora(chalk.cyan('Starting agent...')).start();

      try {
        const onApproval = async (call: any) => {
          spinner.stop();
          console.log(chalk.yellow(`\n⚠️  Tool Approval Required`));
          console.log(chalk.blue(`🔧 Tool: ${call.function.name}`));
          console.log(chalk.dim(`Arguments: ${call.function.arguments}`));

          let approved;
          try {
            const res = await inquirer.prompt([
              {
                type: 'list',
                name: 'approved',
                message: 'Approve this tool execution?',
                choices: [
                  { name: 'Approve (Run)', value: 'yes' },
                  { name: 'Skip (Cancel)', value: 'no' },
                  { name: 'Abort Execution', value: 'abort' }
                ]
              }
            ]);
            approved = res.approved;
          } catch (e) {
            return false;
          }

          if (approved === 'abort') {
            process.exit(1);
          }

          spinner.start(chalk.cyan('Agent thinking...'));
          return approved === 'yes';
        };

        const response = await agent.run(query, (step: AgentStep) => {
          spinner.stop();
          if (step.toolCall) {
            console.log(chalk.blue(`🔧 Executing: ${step.toolCall.function.name}`));
            // Optionally log arguments if they are not too long
            const args = step.toolCall.function.arguments;
            if (args.length < 100) {
              console.log(chalk.dim(`   Args: ${args}`));
            }
          }
          spinner.start(chalk.cyan('Agent thinking...'));
        }, options.mode as 'agent' | 'plan', true, undefined, onApproval); // Use continueSession: true to respect history

        spinner.succeed(chalk.green('Task completed'));
        console.log(`\n - ${chalk.blue(response.content)}\n`);

        // Save session
        if (session) {
          session.messages = agent.getHistory();
          session.metadata.lastUpdatedAt = new Date().toISOString();
          await sessionManager.saveSession(session);
          console.log(chalk.dim(`Session saved: ${currentSessionId}`));
          console.log(chalk.dim(`To resume this session, run: tiny-cli --resume ${currentSessionId}`));
        }
      } catch (error: any) {
        spinner.fail(chalk.red('Agent error'));
        console.error(chalk.red(`\nError: ${error.message}\n`));
      } finally {
        await agent.destroy();
      }
    }
  });

program.parse();
