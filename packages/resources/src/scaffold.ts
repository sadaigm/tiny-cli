import { promises as fs } from "node:fs";
import path from "node:path";

export interface ScaffoldOptions {
  name: string; // validated: lowercase a-z0-9-, 1-64, no bad hyphens
  description: string;
  locationDir: string; // e.g. ~/.tiny-cli/agent/skills or .tiny-cli/skills
  body?: string; // optional pre-written SKILL.md body; default template used when absent
  extras?: string[]; // optional supporting dirs to create (e.g. scripts, references, assets)
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Create `<locationDir>/<name>/SKILL.md` with frontmatter and a body.
 * Creates `extras` subdirectories only when the caller passes them.
 * Returns created paths; does not re-scan (the caller does).
 */
export async function scaffoldSkill(
  opts: ScaffoldOptions
): Promise<{ skillDir: string; files: string[] }> {
  const { name, description, locationDir } = opts;

  if (!name || name.length > 64 || !NAME_RE.test(name)) {
    throw new Error(
      `invalid skill name "${name}": must be 1-64 chars of lowercase a-z, 0-9, and single non-leading/trailing hyphens`
    );
  }
  if (!description.trim()) {
    throw new Error("skill description is required");
  }

  const skillDir = path.join(locationDir, name);
  if (await exists(skillDir)) {
    throw new Error(`skill directory already exists: ${skillDir}`);
  }

  const files: string[] = [];
  await fs.mkdir(skillDir, { recursive: true });

  for (const extra of opts.extras ?? []) {
    await fs.mkdir(path.join(skillDir, extra), { recursive: true });
  }

  const skillMd = path.join(skillDir, "SKILL.md");
  const content = [
    "---",
    `name: ${name}`,
    `description: ${oneLine(description)}`,
    "---",
    "",
    opts.body ?? defaultBody(name),
    "",
  ].join("\n");
  await fs.writeFile(skillMd, content, "utf8");
  files.push(skillMd);

  return { skillDir, files };
}

function defaultBody(name: string): string {
  const title = name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return [
    `# ${title}`,
    "",
    "## Setup",
    "",
    "- [Prerequisites, environment, or credentials needed.]",
    "",
    "## Usage",
    "",
    "- [Step-by-step instructions for the agent to follow when this skill is invoked.]",
    "",
    "<!-- Optional supporting directories, referenced from here with relative paths:",
    "     scripts/    – executable helper scripts",
    "     references/ – documentation the agent can read for detail",
    "     assets/     – templates and other static files -->",
  ].join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\r?\n/g, " ").trim();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
