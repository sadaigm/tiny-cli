#!/usr/bin/env node
import { Command } from 'commander';
import { Agent, AgentStep, SessionManager, logDebug } from '@tiny-cli/core';
import { loadConfig } from './config.js';
import { startTui } from './tui/render.js';
import chalk from 'chalk';

const program = new Command();

/** Merge --skill/--no-skills flags into the agent's skillsOptions. */
function applySkillFlags(config: import('@tiny-cli/core').AgentConfig, options: any): void {
  config.skillsOptions = {
    settingsSkills: config.skillsOptions?.settingsSkills ?? [],
    cliSkills: options.skill ?? [],
    noSkills: options.noSkills === true,
    trusted: config.skillsOptions?.trusted ?? false,
  };
}

program
  .name('tiny-cli')
  .description('A workflow-driven CLI agent powered by small local models')
  .version('1.0.0')
  .option('-r, --resume <id>', 'Resume a specific session by ID')
  .option('-q, --query <text>', 'Explicitly pass a query to execute and exit')
  .option('-m, --mode <type>', 'Execution mode (agent, plan)', 'agent')
  .option('--skill <path>', 'Load an agent skill (file or containing dir); repeatable', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--no-skills', 'Disable skill discovery (explicit --skill paths still load)')
  .argument('[query...]', 'The question or task for the agent')
  .addHelpText('after', `
Examples:
  $ tiny-cli                                     # Starts the interactive TUI
  $ tiny-cli --mode plan                         # Starts the TUI in plan mode
  $ tiny-cli "build a web app"                   # Headless execution in agent mode
  $ tiny-cli -q "draft an architecture" -m plan  # Headless execution in plan mode
`)
  .action(async (queryParts, options) => {
    const positionalQuery = queryParts.join(' ');
    const query = options.query || positionalQuery;

    if (!query) {
      logDebug(`No query provided, starting TUI... stdin.isTTY: ${process.stdin.isTTY}`);
      // No query provided, start the interactive Ink TUI
      const config = await loadConfig();
      applySkillFlags(config, options);

      const agent = new Agent(config);
      await agent.init();
      const sessionManager = new SessionManager();

      // Load or create session
      let currentSessionId = options.resume || SessionManager.createSession().metadata.id;
      let session = await sessionManager.loadSession(currentSessionId);

      if (!session) {
        session = SessionManager.createSession(currentSessionId);
        await sessionManager.saveSession(session);
      }

      agent.setSessionId(currentSessionId);
      agent.setHistory(session.messages);

      try {
        await startTui({
          agent,
          sessionManager,
          session,
          config,
          sessionId: currentSessionId,
          mode: options.mode as 'agent' | 'chat' | 'plan',
        });
      } finally {
        await agent.destroy();
      }
    } else {
      // Single task execution
      const config = await loadConfig();
      applySkillFlags(config, options);

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
      process.stdout.write(chalk.cyan('Running agent...\n'));

      try {
        const onApproval = async (call: any) => {
          console.log(chalk.yellow(`\n⚠️  Headless mode: auto-approving ${call.function.name}`));
          return true;
        };

        const response = await agent.run(query, (step: AgentStep) => {
          if (step.toolCall) {
            console.log(chalk.blue(`🔧 Executing: ${step.toolCall.function.name}`));
            const args = step.toolCall.function.arguments;
            if (args.length < 100) {
              console.log(chalk.dim(`   Args: ${args}`));
            }
          }
        }, options.mode as 'agent' | 'plan', true, undefined, onApproval); // Use continueSession: true to respect history

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
        console.error(chalk.red(`\nError: ${error.message}\n`));
      } finally {
        await agent.destroy();
      }
    }
  });

program.parse();
