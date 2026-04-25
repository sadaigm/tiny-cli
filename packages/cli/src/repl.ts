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

  let currentMode: 'chat' | 'plan' = 'chat';

  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: chalk.green(currentMode === 'plan' ? '(plan) ❯' : '❯'),
        prefix: ''
      }
    ]);

    if (!input || input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(chalk.yellow('Goodbye!'));
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
      console.log(chalk.dim('Standard conversational mode.\n'));
      continue;
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
      }, currentMode);

      spinner.succeed(currentMode === 'plan' ? 'Plan prepared' : 'Task completed');
      console.log(`\n${chalk.blue(response.content)}\n`);

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
              'chat',
              true
            );
            execSpinner.succeed('Execution completed');
            console.log(`\n${chalk.green(execResponse.content)}\n`);
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
