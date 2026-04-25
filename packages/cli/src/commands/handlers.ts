import { Agent } from '@tiny-cli/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import fuzzy from 'fuzzy';
import fetch from 'node-fetch';
import https from 'https';
import ora from 'ora';

// Register autocomplete prompt
inquirer.registerPrompt('autocomplete', autocompletePrompt);

export async function handleModelCommand(agent: Agent) {
  const config = agent.getConfig();
  const baseUrl = config.endpoint.replace(/\/$/, '');
  const url = `${baseUrl}/models`;
  
  let httpsAgent;
  if (config.insecure) {
    httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });
  }
  
  const spinner = ora('Fetching models...').start();
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.apiKey || 'none'}`
      },
      // @ts-ignore
      agent: httpsAgent
    });
    
    if (!response.ok) {
      spinner.fail('Failed to fetch models');
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }
    
    const json = await response.json() as { data?: { id: string }[] };
    spinner.stop();
    
    const models = (json.data || []).map(m => m.id);
    if (models.length === 0) {
      console.log(chalk.yellow('\nNo models found at this endpoint.\n'));
      return;
    }
    
    const { model } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'model',
        message: 'Select a model:',
        source: (_answers: any, input: string) => {
          input = input || '';
          return fuzzy.filter(input, models).map(el => el.original);
        }
      }
    ]);
    
    agent.updateConfig({ model });
    console.log(chalk.green(`\nModel updated to: ${model}\n`));
  } catch (error: any) {
    if (spinner.isSpinning) {
      spinner.fail('Error fetching models');
    }
    console.error(chalk.red(`\nError: ${error.message}\n`));
  }
}

export async function handleToolsCommand(agent: Agent, mode: 'agent' | 'chat' | 'plan') {
  const tools = agent.getToolDefinitions(mode);
  console.log(chalk.cyan('\nAvailable Tools for current mode:'));
  tools.forEach(tool => {
    console.log(`${chalk.yellow(tool.name)}: ${tool.description}`);
  });
  console.log('');
}
