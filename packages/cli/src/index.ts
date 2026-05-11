#!/usr/bin/env node
import { Command } from 'commander';
import { startRepl } from './repl.js';
import { Agent, AgentStep, SessionManager } from '@tiny-cli/core';
import { loadConfig } from './config.js';
import chalk from 'chalk';
import ora from 'ora';

const program = new Command();

program
  .name('tiny-cli')
  .description('A workflow-driven CLI agent powered by small local models')
  .version('1.0.0')
  .option('-r, --resume <id>', 'Resume a specific session by ID')
  .argument('[query...]', 'The question or task for the agent')
  .action(async (queryParts, options) => {
    const query = queryParts.join(' ');

    if (!query) {
      // No query provided, start interactive REPL
      await startRepl(options.resume);
    } else {
      // Single task execution
      const config = await loadConfig();
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

      console.log(chalk.dim(`Session: ${currentSessionId}`));
      const spinner = ora(chalk.cyan('Starting agent...')).start();

      try {
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
        }, 'agent', true); // Use continueSession: true to respect history

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
