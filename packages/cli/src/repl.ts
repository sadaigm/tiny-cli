import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { Agent, AgentStep } from '@tiny-cli/core';
import { loadConfig } from './config.js';

export async function startRepl() {
  const config = await loadConfig();
  const agent = new Agent(config);

  console.log(chalk.bold.cyan('\n🚀 tiny-cli Agent Ready'));
  console.log(chalk.dim(`Model: ${config.model} @ ${config.endpoint}\n`));
  console.log(chalk.dim(`Description: ${config.systemPrompt}\n`));

  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: chalk.green('❯'),
        prefix: ''
      }
    ]);

    if (!input || input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(chalk.yellow('Goodbye!'));
      process.exit(0);
    }

    if (input.toLowerCase() === '/tools') {
      const tools = agent.getToolDefinitions();
      console.log(chalk.cyan('\nAvailable Tools:'));
      tools.forEach(tool => {
        console.log(`${chalk.yellow(tool.name)}: ${tool.description}`);
      });
      console.log('');
      continue;
    }

    const spinner = ora('Thinking...').start();

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
        spinner.start('Thinking...');
      });

      spinner.succeed('Task completed');
      console.log(`\n${chalk.blue(response.content)}\n`);
    } catch (error: any) {
      spinner.fail('Error occurred');
      console.error(chalk.red(error.message));
    }
  }
}
