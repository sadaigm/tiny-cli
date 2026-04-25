import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AgentConfig, DEFAULT_SYSTEM_PROMPT } from '@tiny-cli/core';

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'tiny-cli');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'config.json');
const PROJECT_CONFIG_FILE = path.join(process.cwd(), '.tiny-cli', 'agents.json');
const HOME_PROJECT_CONFIG_FILE = path.join(os.homedir(), '.tiny-cli', 'agents.json');

const DEFAULT_CONFIG: AgentConfig = {
  endpoint: 'http://localhost:11434/v1',
  model: 'llama3.2:latest',
  temperature: 0.7
};

interface AgentProfile {
  name: string;
  model: string;
  description?: string;
  systemPrompt?: string;
  temperature?: number;
  environment?: {
    hostUrl?: string;
    appBasePath?: string;
    apiKey?: string;
    rejectUnauthorized?: boolean;
    insecure?: boolean;
  };
}

export async function loadConfig(): Promise<AgentConfig> {
  // 1. Try project-local config (CWD)
  let configData = await tryReadFile(PROJECT_CONFIG_FILE);
  
  // 2. Try home-project config (~/.tiny-cli/agents.json)
  if (!configData) {
    configData = await tryReadFile(HOME_PROJECT_CONFIG_FILE);
  }

  // 3. Auto-create ~/.tiny-cli/agents.json if missing
  if (!configData) {
    const defaultAgents: AgentProfile[] = [
      {
        name: 'default',
        model: 'llama3.2:latest',
        description: 'Default local assistant (Ollama)',
        systemPrompt: DEFAULT_SYSTEM_PROMPT.trim(),
        temperature: 0.7,
        environment: {
          hostUrl: "http://localhost:11434",
          appBasePath: "/v1",
          insecure: true
        }
      }
    ];
    
    try {
      const homeDir = path.dirname(HOME_PROJECT_CONFIG_FILE);
      await fs.mkdir(homeDir, { recursive: true });
      await fs.writeFile(HOME_PROJECT_CONFIG_FILE, JSON.stringify(defaultAgents, null, 2));
      configData = JSON.stringify(defaultAgents);
      console.log(`✨ Created default configuration at ${HOME_PROJECT_CONFIG_FILE}`);
    } catch (err) {
      // Fallback to internal default
    }
  }

  if (configData) {
    try {
      const profiles: AgentProfile[] = JSON.parse(configData);
      const profile = profiles.find(p => p.name === 'default') || profiles[0];
      
      if (profile) {
        const env = profile.environment;
        const insecure = env?.insecure === true || env?.rejectUnauthorized === false;

        const config: AgentConfig = {
          endpoint: `${env?.hostUrl || 'http://localhost:11434'}${env?.appBasePath || '/v1'}`,
          model: profile.model,
          temperature: profile.temperature,
          systemPrompt: profile.systemPrompt,
          apiKey: env?.apiKey,
          insecure: insecure
        };

        // Merge global settings (like lastSessionId)
        const globalData = await tryReadFile(GLOBAL_CONFIG_FILE);
        if (globalData) {
          const globalConfig = JSON.parse(globalData);
          if (globalConfig.lastSessionId) {
            config.lastSessionId = globalConfig.lastSessionId;
          }
        }

        return config;
      }
    } catch (err) {
      // Invalid JSON
    }
  }

  return DEFAULT_CONFIG;
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
  await fs.writeFile(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2));
}
