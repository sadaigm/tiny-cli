import { exec } from 'child_process';
import path from 'path';
import type { ExecTarget } from '../types.js';
import type { ToolContext } from './registry.js';

/** Single-quote wrap for embedding a command in a shell -c string:
 *  everything between the quotes is literal; ' is closed, escaped, reopened. */
export function sq(cmd: string): string {
  return `'${cmd.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a model-issued command for the profile's execution target.
 *  No `-t` anywhere — output pipes must stay clean for capture. */
export function wrapBashCmd(target: ExecTarget, cmd: string): string {
  const shell = target.shell ?? '/bin/bash';
  switch (target.kind) {
    // Container: run inside the container via its shell; -i (no -t) keeps the
    // output pipe clean for capture.
    case 'container':
      return `docker exec -i ${target.container} ${shell} -c ${sq(cmd)}`;
    // Remote: run on the ssh host; host is passed verbatim so ~/.ssh/config
    // (User/Port/ProxyJump) applies. sq() keeps the command one argument.
    case 'remote':
      return `ssh ${target.host} ${shell} -c ${sq(cmd)}`;
  }
}

/** Map a model-issued path onto the host side through the target's `root` /
 *  `hostRoot` pair. Relative paths resolve against `root`; absolute paths are
 *  allowed only under it. No resolvable host side (root or hostRoot absent),
 *  or path outside `root` → block reason. */
export function mapPath(
  target: ExecTarget,
  p: string
): { ok: true; hostPath: string } | { ok: false; reason: string } {
  // Branch 1 — no host side to map onto: `root` not configured at all
  // (bash-only profile by design §5 edge C→X), or `root` IS configured but
  // `hostRoot` could not be resolved (container not bind-mounted at root /
  // remote without an explicit hostRoot). Block — never fall back to cwd or
  // any other unrelated local directory (design §9: block, not error-through).
  const root = target.root;
  if (!root || !target.hostRoot) {
    return { ok: false, reason: `executes remotely; ${p} is not mapped on this host. Use bash.` };
  }
  // Resolve the model path against the target root: relative paths land
  // inside it (design §5 edge D→E); absolute paths stay as-is.
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  // Branch 2 — path escapes the root (absolute path outside `root`, or a
  // relative path climbing out via `..`): design §5 edge F→X → block.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `executes remotely; ${p} is not mapped on this host. Use bash.` };
  }
  // Branch 3 — inside the root: strip `root`, reattach the verified host
  // mirror dir (design §5 edge E→Z): hostRoot/<relative>.
  return { ok: true, hostPath: path.join(target.hostRoot, rel) };
}

/** Resolve the mount pair for an exec target's `root`, or undefined when
 *  there is none (file tools then run bash-only, per the block rule).
 *  `root` in agents.json is the HOST-side mounted folder; the container's
 *  bind mounts are inspected to find where that folder is mounted inside
 *  the container (Source === root → Destination), and the normalized pair
 *  { root: container path, hostRoot: host path } is returned — the
 *  container-side path is what the model's paths resolve against.
 *  Remote: explicit hostRoot only (ssh exposes no mount table). */
export async function resolveHostRoot(
  target: ExecTarget
): Promise<{ root: string; hostRoot: string } | undefined> {
  // Branch 1 — explicit hostRoot in agents.json wins (the only way to get a
  // host side for `remote` profiles; also overrides auto-detection). root
  // must already be the target-side path in this case.
  if (target.hostRoot && target.root) return { root: target.root, hostRoot: target.hostRoot };
  // Branch 2 — nothing to resolve: no `root` (bash-only) or a remote target
  // without an explicit hostRoot (ssh exposes no mount table to inspect).
  if (!target.root || target.kind !== 'container') return undefined;
  // Branch 3 — container: `root` is the host folder; find the bind mount
  // whose Source matches it and normalize to the container-side Destination.
  try {
    const mounts = await execProbe(`docker inspect -f '{{json .Mounts}}' ${target.container}`, 10_000);
    const list = JSON.parse(mounts || '[]') as Array<{ Type?: string; Source?: string; Destination?: string }>;
    const hit = list.find((m) => m.Type === 'bind' && m.Source === target.root && m.Destination);
    if (hit) return { root: hit.Destination!, hostRoot: hit.Source! };
    return undefined;
  } catch {
    // docker inspect failed (docker missing, container gone) → no host side;
    // file tools will block, the switch-time validation reports the detail.
    return undefined;
  }
}

/** Shared entry point for file tools: resolve the model path to a host path.
 *  Without an exec target the behavior is exactly today's local resolution;
 *  with one, the path is mapped through the target root or blocked. */
export function resolveToolPath(
  p: string,
  context?: ToolContext
): { ok: true; hostPath: string } | { ok: false; reason: string } {
  // Branch 1 — local profile (no `exec` in agents.json): exactly today's
  // resolution; design §5 edge B→Z (local stays byte-identical).
  if (!context?.execTarget) {
    return { ok: true, hostPath: path.resolve(process.cwd(), p) };
  }
  // Branch 2 — exec-target profile: map through root/hostRoot (design §5
  // edges C/D/E/F), which either yields the host path or a block reason.
  const mapped = mapPath(context.execTarget, p);
  if (!mapped.ok) {
    // Blocked: prefix the design's message with the profile name so the
    // model knows which profile the limitation comes from.
    return { ok: false, reason: `${context.profileName ?? 'profile'} ${mapped.reason}` };
  }
  // Mapped: the file tool proceeds against hostPath on the host FS.
  return mapped;
}

function execProbe(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // Non-zero exit / timeout / spawn failure: prefer the probe's own
        // stderr (e.g. ssh's "Permission denied") so the verbatim error
        // reaches the user at /profile time.
        reject(new Error((stderr || stdout || err.message).toString().trim()));
      } else {
        // Probe succeeded; hand back trimmed stdout for the caller to check.
        resolve(stdout.toString().trim());
      }
    });
  });
}

/** Fail-fast check at profile load / switch: schema first, then a live probe
 *  (container exists and is running / ssh host reachable passwordlessly).
 *  Throws with the failing check; the caller refuses the switch. */
export async function validateExecTarget(target: ExecTarget): Promise<void> {
  // --- Check 1: schema — kind ↔ required fields (design §6 step 1). ---
  if (target.kind === 'container') {
    // container kind: a container name is mandatory.
    if (!target.container || typeof target.container !== 'string') {
      throw new Error('exec.kind "container" requires a "container" name.');
    }
  } else if (target.kind === 'remote') {
    // remote kind: an ssh host (or ~/.ssh/config alias) is mandatory.
    if (!target.host || typeof target.host !== 'string') {
      throw new Error('exec.kind "remote" requires a "host".');
    }
  } else {
    // Neither kind: typo'd or missing kind in agents.json.
    throw new Error(`exec.kind must be "container" or "remote" (got "${(target as any).kind}").`);
  }
  // root, when present, must be an absolute target-side path — a relative
  // root would make the startsWith mapping ambiguous.
  if (target.root !== undefined && (!path.isAbsolute(target.root) || typeof target.root !== 'string')) {
    throw new Error('exec.root must be an absolute path when present.');
  }

  // --- Check 2: live probe (design §6 step 2) — throws with the verbatim
  //     error so /profile can refuse the switch. ---
  if (target.kind === 'container') {
    // `.State.Running` errors on an unknown container, so one probe covers
    // both "exists" and "running".
    const state = await execProbe(
      `docker inspect -f '{{.State.Running}}' ${target.container}`,
      10_000
    );
    if (state !== 'true') {
      // Exists but stopped (or unexpected output) → refuse the switch.
      throw new Error(`container "${target.container}" is not running (State.Running=${state || 'unknown'}).`);
    }
  } else {
    // BatchMode=yes disables all prompting, so this verifies passwordless
    // auth specifically instead of hanging on a password prompt.
    await execProbe(`ssh -o BatchMode=yes ${target.host} echo ok`, 15_000);
  }
}
