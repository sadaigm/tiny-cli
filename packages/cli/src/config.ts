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
    /** Execute tool calls that small local models emit as text JSON instead of native tool_calls. Defaults to false. */
    textToolCallFallback?: boolean;
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

/** Tool-owned runtime state, stored in preferences.json next to the resolved agents.json. */
interface Preferences {
  /** Active agents.json profile name (falls back to 'default' || profiles[0] when unset/stale). */
  activeProfile?: string;
  /** Per-profile last-selected model (from /model); wins over the profile's model field. */
  modelOverrides?: Record<string, string>;
}

function preferencesFilePath(agentsFilePath: string): string {
  return path.join(path.dirname(agentsFilePath), 'preferences.json');
}

async function readPreferences(agentsFilePath: string): Promise<Preferences> {
  const data = await tryReadFile(preferencesFilePath(agentsFilePath));
  if (!data) return {};
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writePreferences(agentsFilePath: string, prefs: Preferences): Promise<void> {
  try {
    // Merge with what's on disk so concurrent writers don't clobber each other.
    const merged = { ...(await readPreferences(agentsFilePath)), ...prefs };
    await fs.writeFile(preferencesFilePath(agentsFilePath), JSON.stringify(merged, null, 2));
  } catch {
    // Unwritable location; skip persistence.
  }
}

export async function readActiveProfile(agentsFilePath: string): Promise<string | undefined> {
  return (await readPreferences(agentsFilePath)).activeProfile;
}

export async function writeActiveProfile(agentsFilePath: string, name: string): Promise<void> {
  await writePreferences(agentsFilePath, { activeProfile: name });
}

export async function writeModelOverride(agentsFilePath: string, profileName: string, model: string | undefined): Promise<void> {
  const prefs = await readPreferences(agentsFilePath);
  const overrides = { ...(prefs.modelOverrides ?? {}) };
  if (model === undefined) delete overrides[profileName];
  else overrides[profileName] = model;
  await writePreferences(agentsFilePath, { modelOverrides: overrides });
}

/**
 * Resolves and parses agents.json with the same precedence as loadConfig:
 * project-local first, then home. Auto-creates the home file when neither
 * exists. Returns null when no readable profile list remains.
 */
export async function loadProfiles(): Promise<{ profiles: AgentProfile[]; filePath: string } | null> {
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

  if (!configData) return null;
  try {
    const profiles: AgentProfile[] = JSON.parse(configData);
    if (!Array.isArray(profiles) || profiles.length === 0) return null;
    return { profiles, filePath: configFilePath };
  } catch {
    return null;
  }
}

/** Maps an agents.json profile to an AgentConfig. Applies the per-profile
 * model override from preferences.json when present. */
export function profileToConfig(profile: AgentProfile, trusted: boolean, prefs?: Preferences): AgentConfig {
  const env = profile.environment;
  const insecure = env?.insecure === true || env?.rejectUnauthorized === false;

  return {
    endpoint: `${env?.hostUrl || 'http://localhost:11434'}${env?.appBasePath || '/v1'}`,
    model: prefs?.modelOverrides?.[profile.name] ?? profile.model,
    temperature: profile.temperature,
    systemPrompt: profile.systemPrompt,
    prompts: profile.prompts,
    apiKey: expandApiKey(env?.apiKey),
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
      trusted
    },
    enableSkillCommands: profile.enableSkillCommands !== false,
    lastSessionId: profile.settings?.lastSessionId,
    textToolCallFallback: profile.settings?.textToolCallFallback === true,
    activeSkills: profile.settings?.activeSkills,
    profileName: profile.name
  };
}

export async function loadConfig(): Promise<AgentConfig> {
  const loaded = await loadProfiles();
  if (!loaded) return DEFAULT_CONFIG;
  const { profiles, filePath: configFilePath } = loaded;
  const prefs = await readPreferences(configFilePath);

  // Selection: stored active profile, else the legacy default/first entry.
  const profile = profiles.find(p => p.name === prefs.activeProfile)
    || profiles.find(p => p.name === 'default')
    || profiles[0];
  if (!profile) return DEFAULT_CONFIG;

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

  return profileToConfig(profile, await isProjectTrusted(), prefs);
}

/**
 * Resolves an apiKey of the form "${VAR_NAME}" from the process environment
 * (e.g. a token injected into a Docker container). Plain strings pass through
 * unchanged; an unset/empty variable yields undefined with a warning, so the
 * TUI still starts. The expanded value never gets written back to agents.json.
 */
function expandApiKey(value: string | undefined): string | undefined {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value ?? '');
  if (!match) return value;
  const expanded = process.env[match[1]];
  if (!expanded) {
    console.warn(`⚠️  agents.json apiKey references ${match[0]}, which is not set — requests will be sent without an API key`);
    return undefined;
  }
  return expanded;
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
export async function isProjectTrusted(): Promise<boolean> {
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
    const profile = profiles.find(p => p.name === config.profileName)
      || profiles.find(p => p.name === 'default')
      || profiles[0];
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
