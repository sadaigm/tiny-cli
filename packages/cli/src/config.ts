import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AgentConfig, DEFAULT_SYSTEM_PROMPT, McpServerConfig, PermissionMode, LogLevel } from '@tiny-cli/core';

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
  /** Per-mode system-prompt overrides; unset modes use the built-in prompts. */
  prompts?: {
    agent?: string;
    chat?: string;
    plan?: string;
  };
  temperature?: number;
  /** @deprecated Use settings.permissionMode — migrated on load. */
  permissionMode?: PermissionMode;
  /** Settings block shared with the GUI; single source of truth for permissionMode. */
  settings?: {
    permissionMode?: PermissionMode;
    lastSessionId?: string;
    activeSkills?: string[];
  };
  logLevel?: LogLevel;
  maxIterations?: number;
  compactionThresholdTokens?: number;
  compactionRetainTokens?: number;
  environment?: {
    hostUrl?: string;
    appBasePath?: string;
    apiKey?: string;
    rejectUnauthorized?: boolean;
    insecure?: boolean;
  };
  mcpServers?: McpServerConfig[];
  /** Extra skill files/directories to load (agents.json "skills" array). */
  skills?: string[];
  /** Whether /skill:<name> TUI commands are enabled. Defaults to true. */
  enableSkillCommands?: boolean;
}

export async function loadConfig(): Promise<AgentConfig> {
  // 1. Try project-local config (CWD)
  let configData = await tryReadFile(PROJECT_CONFIG_FILE);
  let configFilePath = PROJECT_CONFIG_FILE;

  // 2. Try home-project config (~/.tiny-cli/agents.json)
  if (!configData) {
    configData = await tryReadFile(HOME_PROJECT_CONFIG_FILE);
    configFilePath = HOME_PROJECT_CONFIG_FILE;
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
        // permissionMode: settings block is the single source of truth.
        // Migrate a legacy root-level key and drop it from the file.
        if (profile.permissionMode !== undefined) {
          if (profile.settings?.permissionMode === undefined) {
            profile.settings = { ...profile.settings, permissionMode: profile.permissionMode };
          } else if (profile.settings.permissionMode !== profile.permissionMode) {
            console.warn(
              `⚠️  ${configFilePath}: conflicting permissionMode keys — using settings.permissionMode "${profile.settings.permissionMode}" (root-level "${profile.permissionMode}" ignored)`
            );
          }
          delete profile.permissionMode;
          try {
            await fs.writeFile(configFilePath, JSON.stringify(profiles, null, 2));
          } catch {
            // Read-only config location; the in-memory migration still applies.
          }
        }

        const env = profile.environment;
        const insecure = env?.insecure === true || env?.rejectUnauthorized === false;

        const config: AgentConfig = {
          endpoint: `${env?.hostUrl || 'http://localhost:11434'}${env?.appBasePath || '/v1'}`,
          model: profile.model,
          temperature: profile.temperature,
          systemPrompt: profile.systemPrompt,
          prompts: profile.prompts,
          apiKey: env?.apiKey,
          insecure: insecure,
          mcpServers: profile.mcpServers,
          permissionMode: profile.settings?.permissionMode,
          logLevel: profile.logLevel,
          maxIterations: profile.maxIterations,
          compactionThresholdTokens: profile.compactionThresholdTokens,
          compactionRetainTokens: profile.compactionRetainTokens,
          skillsOptions: {
            settingsSkills: profile.skills ?? [],
            cliSkills: [],
            noSkills: false,
            trusted: await isProjectTrusted()
          },
          enableSkillCommands: profile.enableSkillCommands !== false,
          lastSessionId: profile.settings?.lastSessionId,
          activeSkills: profile.settings?.activeSkills
        };

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

/**
 * No dedicated trust mechanism exists yet; a project that already carries a
 * local `.tiny-cli/agents.json` is treated as trusted for project-skill loading.
 */
async function isProjectTrusted(): Promise<boolean> {
  try {
    await fs.access(PROJECT_CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists cross-run runtime state (lastSessionId, activeSkills) into the
 * active profile's settings block in agents.json — the single config file.
 */
export async function saveConfig(config: AgentConfig): Promise<void> {
  // Same file precedence as loadConfig: project-local, then home.
  let filePath = PROJECT_CONFIG_FILE;
  let data = await tryReadFile(filePath);
  if (!data) {
    filePath = HOME_PROJECT_CONFIG_FILE;
    data = await tryReadFile(filePath);
  }
  if (!data) return;

  try {
    const profiles: AgentProfile[] = JSON.parse(data);
    const profile = profiles.find(p => p.name === 'default') || profiles[0];
    if (!profile) return;

    profile.settings = {
      ...profile.settings,
      ...(config.lastSessionId ? { lastSessionId: config.lastSessionId } : {}),
      ...(config.activeSkills ? { activeSkills: config.activeSkills } : {})
    };
    await fs.writeFile(filePath, JSON.stringify(profiles, null, 2));
  } catch {
    // Invalid JSON or unwritable location; skip persistence.
  }
}
