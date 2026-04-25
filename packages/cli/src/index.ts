#!/usr/bin/env node
import { Command } from 'commander';
import { startRepl } from './repl.js';
import { Agent, AgentStep } from '@tiny-cli/core';
import { loadConfig } from './config.js';
import chalk from 'chalk';
import ora from 'ora';

const program = new Command();

program
  .name('tiny-cli')
  .description('A workflow-driven CLI agent powered by small local models')
  .version('1.0.0')
  .argument('[query...]', 'The question or task for the agent')
  .action(async (queryParts) => {
    const query = queryParts.join(' ');

    if (!query) {
      // No query provided, start interactive REPL
      await startRepl();
    } else {
      // Single task execution
      const config = await loadConfig();
      const agent = new Agent(config);
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
        });

        spinner.succeed(chalk.green('Task completed'));
        console.log(`\n - ${chalk.blue(response.content)}\n`);
      } catch (error: any) {
        spinner.fail(chalk.red('Agent error'));
        console.error(chalk.red(`\nError: ${error.message}\n`));
      }
    }
  });

program.parse();
