import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill, SkillsResult, SkillSource, SkillWarning } from "./types.js";
import { parseFrontmatter, validateSkill } from "./parse.js";

export interface LoadSkillsOptions {
  settingsSkills: string[]; // from config "skills" array (files or dirs)
  cliSkills: string[]; // from --skill flags
  noSkills: boolean; // from --no-skills
  trusted: boolean; // project trust flag
}

/** Bundled skills shipped with this package (e.g. the create-skill meta-skill). */
function bundledSkillsDir(): string {
  // Works both from src/ (src/../skills) and dist/ (dist/../../skills)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "skills");
}

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read only the first ~2 KB of a candidate skill file — enough for the
 * frontmatter block; bodies are never read during discovery.
 */
async function readHead(p: string): Promise<string> {
  const fh = await fs.open(p, "r");
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await fh.read(buf, 0, 2048, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Root-level .md files in a directory (one skill each). */
async function rootMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(dir, e.name));
}

/**
 * Recursively find SKILL.md files. When a directory contains SKILL.md we do
 * not descend into it further (subdirectories of a skill belong to the skill).
 */
async function findSkillMds(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const child = path.join(dir, e.name);
    if (await isFile(path.join(child, "SKILL.md"))) {
      found.push(path.join(child, "SKILL.md"));
    } else {
      found.push(...(await findSkillMds(child)));
    }
  }
  return found;
}

/** Project .agents/skills walk: cwd upward, stopping at the git repo root or fs root. */
async function ancestorAgentsSkillDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    dirs.push(path.join(current, ".agents", "skills"));
    if (await isDir(path.join(current, ".git"))) break; // git repo root reached
    const parent = path.dirname(current);
    if (parent === current) break; // fs root
    current = parent;
  }
  return dirs;
}

interface Candidate {
  file: string;
  source: SkillSource;
}

async function collectCandidates(opts: LoadSkillsOptions): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const home = homeDir();
  const cwd = process.cwd();

  // Built-in bundled skills — listed before user locations but lowest priority
  // on collision, so users can override them (e.g. their own create-skill).
  const bundled = await findSkillMds(bundledSkillsDir()).catch(() => [] as string[]);
  for (const file of bundled) candidates.push({ file, source: "package" });

  // 6. cliSkills — always loaded, even when noSkills is true (file or containing dir)
  const cliCandidates: Candidate[] = [];
  for (const entry of opts.cliSkills ?? []) {
    const resolved = path.resolve(entry);
    if (await isFile(resolved)) {
      cliCandidates.push({ file: resolved, source: "cli" });
    } else if (await isDir(resolved)) {
      for (const file of await findSkillMds(resolved)) cliCandidates.push({ file, source: "cli" });
    }
  }

  if (opts.noSkills) return [...candidates, ...cliCandidates];

  // 1. ~/.tiny-cli/agent/skills/ — root .md files + recursive SKILL.md dirs
  const globalTiny = path.join(home, ".tiny-cli", "agent", "skills");
  if (await isDir(globalTiny)) {
    for (const file of await rootMarkdownFiles(globalTiny)) candidates.push({ file, source: "global" });
    for (const file of await findSkillMds(globalTiny)) candidates.push({ file, source: "global" });
  }

  // 2. ~/.agents/skills/ — recursive SKILL.md dirs only
  const globalAgents = path.join(home, ".agents", "skills");
  if (await isDir(globalAgents)) {
    for (const file of await findSkillMds(globalAgents)) candidates.push({ file, source: "agents" });
  }

  if (opts.trusted) {
    // 3. .tiny-cli/skills/ (from cwd) — root .md files + recursive SKILL.md dirs
    const projTiny = path.join(cwd, ".tiny-cli", "skills");
    if (await isDir(projTiny)) {
      for (const file of await rootMarkdownFiles(projTiny)) candidates.push({ file, source: "project" });
      for (const file of await findSkillMds(projTiny)) candidates.push({ file, source: "project" });
    }

    // 4. .agents/skills/ walking cwd -> ancestors, stopping at git repo root or fs root
    for (const dir of await ancestorAgentsSkillDirs(cwd)) {
      if (await isDir(dir)) {
        for (const file of await findSkillMds(dir)) candidates.push({ file, source: "project" });
      }
    }
  }

  // 5. settingsSkills — each file is a skill; each dir scanned for recursive SKILL.md
  for (const entry of opts.settingsSkills ?? []) {
    const resolved = path.resolve(entry);
    if (await isFile(resolved)) {
      candidates.push({ file: resolved, source: "settings" });
    } else if (await isDir(resolved)) {
      for (const file of await findSkillMds(resolved)) candidates.push({ file, source: "settings" });
    }
  }

  return [...candidates, ...cliCandidates];
}

export async function loadSkills(opts: LoadSkillsOptions): Promise<SkillsResult> {
  const warnings: SkillWarning[] = [];
  const skills: Skill[] = [];
  const byName = new Map<string, Skill>();

  for (const { file, source } of await collectCandidates(opts)) {
    const content = await readHead(file).catch(() => "");
    if (!content) continue;
    const fm = parseFrontmatter(content);
    const { warnings: w, fatal, name } = validateSkill(fm, file);
    warnings.push(...w);
    if (fatal) continue;

    const existing = byName.get(name);
    if (existing) {
      // Bundled skills are lowest priority: a user location overrides them.
      if (existing.source === "package" && source !== "package") {
        skills.splice(skills.indexOf(existing), 1);
        byName.set(name, toSkill(name, fm, file, source));
        skills.push(byName.get(name)!);
        warnings.push({ path: existing.path, message: `bundled skill "${name}" overridden by ${file}` });
      } else {
        warnings.push({
          path: file,
          message: `duplicate skill name "${name}" from ${file}, keeping first`,
        });
      }
      continue;
    }
    byName.set(name, toSkill(name, fm, file, source));
    skills.push(byName.get(name)!);
  }

  return { skills, warnings };
}

function toSkill(name: string, fm: Record<string, string>, file: string, source: SkillSource): Skill {
  return {
    name,
    description: (fm.description ?? "").trim(),
    path: path.resolve(file),
    source,
    invocationDisabled: (fm["disable-model-invocation"] ?? "").trim().toLowerCase() === "true",
  };
}
