import crypto from 'crypto';
import { Agent } from '../agent.js';
import { SessionManager } from '../session.js';
import type { AgentConfig, Message, SubAgentProfile, AgentStep } from '../types.js';
import type { LoadSkillsOptions } from '@tiny-cli/resources';
import type {
  SubAgentInstance,
  SpawnSubAgentOptions,
  SubAgentSummary,
} from './types.js';
import { buildSubAgentSystemPrompt } from './prompt.js';
import { logInfo, logError, logDebug } from '../logger.js';

// ── Process-wide singleton ─────────────────────────────────────────────
// One manager per terminal process. The session ID is *state*, not identity:
// switching sessions just repoints the manager (setCurrentSession) — running
// sub-agents keep running, tagged with the session they were spawned under.
// This also removes the old failure mode where Agent.updateConfig()/setSessionId()
// silently replaced the manager and orphaned live instances.
let singleton: SubAgentManager | undefined;

/**
 * Returns the process-wide SubAgentManager, creating it on first use.
 * Later calls only repoint the current session — they NEVER touch profiles.
 * Strict rule: worker profiles are seeded once at launch (first call) and
 * replaced ONLY by an explicit profile switch (SubAgentManager.updateProfiles
 * from a user command). Empty/transient arrays simply don't update anything.
 */
export function getSubAgentManager(
  parentSessionId: string,
  profiles: Array<SubAgentProfile | string> = [],
  insecure = false,
  parentMaxIterations?: number,
  skills?: { skillsOptions?: LoadSkillsOptions; activeSkills?: string[] }
): SubAgentManager {
  if (!singleton) {
    singleton = new SubAgentManager(parentSessionId, profiles, insecure);
  } else {
    singleton.parentInsecure = insecure;
    singleton.setCurrentSession(parentSessionId);
  }
  if (parentMaxIterations !== undefined) {
    singleton.parentMaxIterations = parentMaxIterations;
  }
  if (skills) {
    singleton.updateSkills(skills);
  }
  return singleton;
}

export class SubAgentManager {
  /** Live (running) instances, keyed by id. */
  private instances = new Map<string, SubAgentInstance>();
  /** Finished (completed/failed) instances this process has seen, keyed by id. */
  private finished = new Map<string, SubAgentInstance>();
  private sessionManager: SessionManager;
  private availableProfiles: Map<string, SubAgentProfile> = new Map();

  /** Optional callback fired when any sub-agent's status or current tool changes */
  onStatusChange?: (summary?: SubAgentSummary) => void;

  /** Fired once when a sub-agent completes or fails (after its session is
   * persisted). Lets the mentor react to worker completion without polling. */
  onSubAgentComplete?: (summary: SubAgentSummary) => void;

  /** TLS inheritance flag for newly spawned workers (settable by the singleton accessor). */
  parentInsecure: boolean;

  /** Iteration budget inherited from the mentor's config; a worker profile's
   * own maxIterations (if set) takes precedence. */
  parentMaxIterations?: number;

  /** Skills inherited from the mentor so workers can use skill bodies without
   * reading files outside their workspace boundary. */
  private parentSkills?: { skillsOptions?: LoadSkillsOptions; activeSkills?: string[] };

  constructor(
    private parentSessionId: string,
    profiles: Array<SubAgentProfile | string> = [],
    parentInsecure = false
  ) {
    // Relative sub-path: resolves cleanly to .tiny-cli/sessions/<parentSessionId>/sub
    this.sessionManager = new SessionManager(`${parentSessionId}/sub`);
    this.parentInsecure = parentInsecure;

    for (const p of profiles) {
      if (typeof p === 'object' && p.name) {
        this.availableProfiles.set(p.name, p);
      }
    }
  }

  /**
   * Repoint the manager at a different session. Running sub-agents from the
   * previous session keep running in the background — they stay in the live
   * map tagged with their own parentSessionId and reappear when that session
   * becomes current again. list() only surfaces the current session's agents.
   */
  setCurrentSession(id: string): void {
    if (this.parentSessionId === id) return;
    this.parentSessionId = id;
    this.sessionManager = new SessionManager(`${id}/sub`);
    this.notifyAll();
  }

  /** Replace the available worker profiles (called on config updates). */
  updateProfiles(profiles: Array<SubAgentProfile | string>): void {
    this.availableProfiles.clear();
    for (const p of profiles) {
      if (typeof p === 'object' && p.name) {
        this.availableProfiles.set(p.name, p);
      }
    }
  }

  /** Update inherited skills (mentor toggled a skill via /skills). */
  updateSkills(skills: { skillsOptions?: LoadSkillsOptions; activeSkills?: string[] }): void {
    this.parentSkills = skills;
  }

  getAvailableProfiles(): SubAgentProfile[] {
    return Array.from(this.availableProfiles.values());
  }

  addProfile(profile: SubAgentProfile): void {
    this.availableProfiles.set(profile.name, profile);
  }

  async spawn(options: SpawnSubAgentOptions): Promise<SubAgentInstance> {
    const id = options.id || crypto.randomUUID().slice(0, 8);
    const name = options.name || `sub-${id}`;

    // Resolve profile
    let profile: SubAgentProfile;
    if (typeof options.profile === 'object') {
      profile = options.profile;
    } else if (typeof options.profile === 'string' && this.availableProfiles.has(options.profile)) {
      profile = this.availableProfiles.get(options.profile)!;
    } else if (this.availableProfiles.size > 0) {
      profile = this.availableProfiles.values().next().value!;
    } else {
      // Default fallback worker profile
      profile = {
        name: 'default-worker',
        model: 'llama3.2:latest',
        endpoint: 'http://localhost:11434/v1',
      };
    }

    // Ensure asset directory is created at .tiny-cli/sessions/<parentSessionId>/sub/<id>/
    await this.sessionManager.ensureAssetDir(id);

    // Build system prompt with task and context
    const systemPrompt = buildSubAgentSystemPrompt({
      task: options.task,
      parentSessionId: this.parentSessionId,
      contextFiles: options.contextFiles,
    });

    // Create AgentConfig for this sub-agent
    const agentConfig: AgentConfig = {
      endpoint: profile.endpoint || 'http://localhost:11434/v1',
      model: profile.model,
      apiKey: profile.apiKey,
      headers: profile.headers,
      // TLS: inherit the mentor's insecure setting (corporate proxies /
      // self-signed certs) unless the worker profile overrides it.
      insecure: profile.insecure ?? this.parentInsecure,
      temperature: profile.temperature ?? 0.2,
      max_tokens: profile.max_tokens ?? 8192,
      // Iteration budget: worker profile override → mentor's config → 25
      maxIterations: profile.maxIterations ?? this.parentMaxIterations,
      // Skills: inherit the mentor's discovery options and active skills so
      // "use skill X" in a task works for workers exactly as it does for the
      // mentor — the skill body lands in the worker's system prompt, no file
      // read required (skill files often live outside the worker's workspace).
      skillsOptions: this.parentSkills?.skillsOptions,
      activeSkills: this.parentSkills?.activeSkills,
      systemPrompt,
      sessionId: id,
      permissionMode: 'auto-edit', // Sub-agents run autonomously in auto-edit
      securedMode: true,
      // Never let this Agent touch the SubAgentManager singleton — its
      // construction would wipe mentor profiles and repoint the manager's
      // session at this sub-agent's id (sidebar then shows only this agent).
      isSubAgent: true,
    };

    const agent = new Agent(agentConfig);
    const abortController = new AbortController();

    // Create initial persisted session file at .tiny-cli/sessions/<parentSessionId>/sub/<id>.json
    const initialSession = SessionManager.createSession(id);
    initialSession.metadata.profileName = profile.name;
    await this.sessionManager.saveSession(initialSession);

    const instance: SubAgentInstance = {
      id,
      name,
      status: 'running',
      task: options.task,
      profile,
      agent,
      sessionId: id,
      parentSessionId: this.parentSessionId,
      startedAt: Date.now(),
      mentorDirections: [],
      abortController,
    };

    this.instances.set(id, instance);
    this.notifyStatus(instance);

    // Kick off background execution (unawaited). runInstance records the
    // failure, persists the session and notifies the UI before rethrowing —
    // so the throw is swallowed here. Without this catch the rejection is
    // unhandled and crashes/spams the terminal when a worker endpoint is down.
    instance.promise = this.runInstance(instance).catch(() => '');

    logInfo(`[SubAgentManager] Spawned sub-agent ${name} (id: ${id}, model: ${profile.model}, profile: ${profile.name}, endpoint: ${agentConfig.endpoint}, insecure: ${agentConfig.insecure === true})`);
    return instance;
  }

  private async runInstance(instance: SubAgentInstance, initialPrompt?: string): Promise<string> {
    const inputPrompt = initialPrompt || instance.task;
    instance.status = 'running';
    this.notifyStatus(instance);

    try {
      const response = await instance.agent.run(
        inputPrompt,
        (step: AgentStep) => {
          if (step.toolCall) {
            instance.currentTool = step.toolCall.function.name;
            this.notifyStatus(instance);
            // Per-step progress for tracking in tui.log (DEBUG — only lands
            // in the file when the level allows; never printed to the TUI).
            logDebug(
              `[SubAgentManager] Sub-agent ${instance.name} (${instance.id}) tool call: ${step.toolCall.function.name}`
            );
          }
          instance.uiCallbacks?.onStep?.(step);
        },
        'agent',
        true, // continueSession
        instance.abortController.signal,
        undefined,
        instance.uiCallbacks?.onText
          ? (delta: string) => {
              // Accumulate streamed text; logged once per turn below.
              instance.textBuf = (instance.textBuf ?? '') + delta;
              instance.uiCallbacks?.onText?.(delta);
            }
          : undefined,
        instance.uiCallbacks?.onReasoning
          ? (delta: string) => instance.uiCallbacks?.onReasoning?.(delta)
          : undefined
      );

      // If kill() fired mid-run, agent.run resolves normally with a
      // cancellation message instead of throwing — do not treat that as done.
      if (instance.abortController.signal.aborted) {
        instance.status = 'cancelled';
        instance.error = 'Cancelled';
        instance.completedAt = Date.now();
        instance.currentTool = undefined;
        instance.textBuf = undefined;
        await this.saveInstanceSession(instance);
        this.retire(instance);
        instance.uiCallbacks?.onDone?.('', 'Cancelled');
        this.notifyStatus(instance);
        this.onSubAgentComplete?.(this.toSummary(instance));
        logInfo(`[SubAgentManager] Sub-agent ${instance.name} (${instance.id}) aborted — marked cancelled.`);
        return '';
      }

      instance.status = 'completed';
      instance.completedAt = Date.now();
      instance.summary = response.content;
      instance.currentTool = undefined;
      // Log the accumulated streamed text (if any) for post-hoc tracking.
      if (instance.textBuf) {
        logDebug(`[SubAgentManager] Sub-agent ${instance.name} (${instance.id}) streamed text:\n${instance.textBuf}`);
        instance.textBuf = undefined;
      }

      // Persist completed history, then retire from the live map — only
      // running agents stay in memory; finished ones are file-backed.
      await this.saveInstanceSession(instance);
      this.retire(instance);
      instance.uiCallbacks?.onDone?.(response.content);
      this.notifyStatus(instance);
      this.onSubAgentComplete?.(this.toSummary(instance));
      logInfo(`[SubAgentManager] Sub-agent ${instance.name} (${instance.id}) completed successfully.`);
      return response.content;
    } catch (err: any) {
      if (instance.abortController.signal.aborted) {
        instance.status = 'cancelled';
        instance.error = 'Execution aborted by user or mentor.';
      } else {
        instance.status = 'failed';
        instance.error = err.message || String(err);
        logError(`[SubAgentManager] Sub-agent ${instance.name} (${instance.id}) failed: ${err.message}`);
      }

      instance.completedAt = Date.now();
      instance.currentTool = undefined;
      if (instance.textBuf) {
        logDebug(`[SubAgentManager] Sub-agent ${instance.name} (${instance.id}) streamed text:\n${instance.textBuf}`);
      }
      instance.textBuf = undefined;
      await this.saveInstanceSession(instance);
      this.retire(instance);
      instance.uiCallbacks?.onDone?.('', instance.error);
      this.notifyStatus(instance);
      this.onSubAgentComplete?.(this.toSummary(instance));
      throw err;
    }
  }

  private async saveInstanceSession(instance: SubAgentInstance): Promise<void> {
    try {
      const session =
        (await this.sessionManager.loadSession(instance.id)) ||
        SessionManager.createSession(instance.id);
      session.messages = instance.agent.getHistory();
      session.metadata.lastUpdatedAt = new Date().toISOString();
      await this.sessionManager.saveSession(session);
    } catch (e: any) {
      logDebug(`[SubAgentManager] Failed to persist session for ${instance.id}: ${e.message}`);
    }
  }

  /** Move a finished instance from the live map to the finished map. */
  private retire(instance: SubAgentInstance): void {
    this.instances.delete(instance.id);
    this.finished.set(instance.id, instance);
  }

  private notifyStatus(instance: SubAgentInstance): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.toSummary(instance));
    }
  }

  /** Fire the status callback for every live agent of the current session. */
  private notifyAll(): void {
    for (const inst of this.instances.values()) {
      if (inst.parentSessionId === this.parentSessionId) {
        this.notifyStatus(inst);
      }
    }
    // Always nudge once so listeners re-pull the (possibly empty) list.
    if (this.onStatusChange) this.onStatusChange();
  }

  private toSummary(instance: SubAgentInstance): SubAgentSummary {
    return {
      id: instance.id,
      name: instance.name,
      status: instance.status,
      model: instance.profile.model,
      currentTool: instance.currentTool,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
      summary: instance.summary,
      error: instance.error,
    };
  }

  get(id: string): SubAgentInstance | undefined {
    return this.instances.get(id) ?? this.finished.get(id);
  }

  /** Attach live UI listeners (KVM switch) to a sub-agent's ongoing execution. */
  attachListener(
    id: string,
    callbacks: NonNullable<SubAgentInstance['uiCallbacks']>
  ): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    instance.uiCallbacks = callbacks;
    return true;
  }

  /** Detach live UI listeners (screen unplugged from this sub-agent). */
  detachListener(id: string): void {
    const instance = this.instances.get(id);
    if (instance) instance.uiCallbacks = undefined;
  }

  getSummary(id: string): SubAgentSummary | undefined {
    const inst = this.instances.get(id) ?? this.finished.get(id);
    return inst ? this.toSummary(inst) : undefined;
  }

  /**
   * Summaries for the current session: running agents first (live memory),
   * then finished ones (completed/failed, most recent first).
   */
  list(): SubAgentSummary[] {
    const live = Array.from(this.instances.values())
      .filter((inst) => inst.parentSessionId === this.parentSessionId)
      .map((inst) => this.toSummary(inst));
    const done = Array.from(this.finished.values())
      .filter((inst) => inst.parentSessionId === this.parentSessionId)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .map((inst) => this.toSummary(inst));
    return [...live, ...done];
  }

  getConversation(id: string): Message[] {
    const instance = this.instances.get(id) ?? this.finished.get(id);
    return instance ? instance.agent.getHistory() : [];
  }

  async sendToSub(id: string, message: string): Promise<boolean> {
    const instance = this.instances.get(id) ?? this.finished.get(id);
    if (!instance) return false;

    instance.mentorDirections.push(message);
    const formattedDirection = `[MENTOR DIRECTION]: ${message}`;

    logInfo(`[SubAgentManager] Injecting mentor direction into sub-agent ${instance.name} (${id})`);

    // If sub-agent completed or failed, we re-trigger it with the mentor's feedback
    if (instance.status === 'completed' || instance.status === 'failed') {
      instance.abortController = new AbortController();
      this.instances.set(instance.id, instance); // back to the live map while it re-runs
      this.finished.delete(instance.id);
      instance.promise = this.runInstance(instance, formattedDirection).catch(() => '');
      return true;
    }

    // If currently running, add as user message into history so next model call sees it
    const history = instance.agent.getHistory();
    history.push({
      role: 'user',
      content: formattedDirection,
    });
    instance.agent.setHistory(history);
    await this.saveInstanceSession(instance);
    return true;
  }

  kill(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;

    instance.abortController.abort();
    instance.status = 'cancelled';
    instance.error = 'Cancelled';
    this.notifyStatus(instance);
    logInfo(`[SubAgentManager] Sub-agent ${instance.name} (${id}) killed by user.`);
    return true;
  }

  killAll(): void {
    for (const id of this.instances.keys()) {
      this.kill(id);
    }
  }
}

