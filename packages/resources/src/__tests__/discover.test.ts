import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkills } from "../discover.js";

const baseOpts = { settingsSkills: [], cliSkills: [], noSkills: false, trusted: false };

let tmp = "";
let home = "";
let proj = "";
let savedHome = "";
let savedCwd = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skills-"));
  home = path.join(tmp, "home");
  proj = path.join(tmp, "proj");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(proj, { recursive: true });
  savedHome = process.env.HOME ?? "";
  savedCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(proj);
});

afterEach(async () => {
  process.chdir(savedCwd);
  process.env.HOME = savedHome;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = "";
});

async function writeSkill(
  rel: string,
  fm: string = "description: A skill.",
  body = "Body."
): Promise<string> {
  if (!fm.includes("description:")) fm = `${fm}\ndescription: A skill.`;
  const p = path.join(tmp, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `---\n${fm}\n---\n\n${body}\n`, "utf8");
  return p;
}

describe("loadSkills", () => {
  it("discovers bundled create-skill meta-skill", async () => {
    const r = await loadSkills(baseOpts);
    const names = r.skills.map((s) => s.name);
    expect(names).toContain("create-skill");
    expect(r.skills.find((s) => s.name === "create-skill")?.source).toBe("package");
  });

  it("finds root .md and recursive SKILL.md in ~/.tiny-cli locations", async () => {
    await writeSkill("home/.tiny-cli/agent/skills/root-skill.md", "name: root-skill");
    await writeSkill(
      "home/.tiny-cli/agent/skills/dir-skill/SKILL.md",
      "name: dir-skill\ndescription: Dir skill."
    );
    const r = await loadSkills(baseOpts);
    expect(r.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["create-skill", "root-skill", "dir-skill"])
    );
  });

  it("ignores root .md in ~/.agents/skills but finds recursive SKILL.md", async () => {
    await writeSkill("home/.agents/skills/ignored.md", "name: ignored");
    await writeSkill(
      "home/.agents/skills/nested/skill/SKILL.md",
      "name: nested-skill\ndescription: Nested."
    );
    const r = await loadSkills(baseOpts);
    const names = r.skills.map((s) => s.name);
    expect(names).toContain("nested-skill");
    expect(names).not.toContain("ignored");
  });

  it("skips untrusted project dirs and loads them when trusted", async () => {
    await writeSkill("proj/.tiny-cli/skills/proj-skill/SKILL.md", "name: proj-skill");
    const untrusted = await loadSkills(baseOpts);
    expect(untrusted.skills.map((s) => s.name)).not.toContain("proj-skill");
    const trusted = await loadSkills({ ...baseOpts, trusted: true });
    expect(trusted.skills.map((s) => s.name)).toContain("proj-skill");
  });

  it("walks ancestor .agents/skills up to the git root when trusted", async () => {
    const repoRoot = path.join(tmp, "repo");
    const nested = path.join(repoRoot, "a", "b");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const skillPath = await writeSkill("repo/.agents/skills/up-skill/SKILL.md", "name: up-skill");
    process.chdir(nested);
    const r = await loadSkills({ ...baseOpts, trusted: true });
    expect(r.skills.map((s) => s.name)).toContain("up-skill");
    expect(r.skills.find((s) => s.name === "up-skill")?.path).toBe(skillPath);
  });

  it("loads settings skills (files and dirs)", async () => {
    const fileSkill = await writeSkill("extra/single.md", "name: single-skill");
    await writeSkill("extra/pack/skill/SKILL.md", "name: packed-skill\ndescription: Packed.");
    const r = await loadSkills({
      ...baseOpts,
      settingsSkills: [fileSkill, path.join(tmp, "extra")],
    });
    expect(r.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["single-skill", "packed-skill"])
    );
  });

  it("noSkills skips discovery but keeps cliSkills", async () => {
    await writeSkill("home/.tiny-cli/agent/skills/gone.md", "name: gone");
    const cliSkill = await writeSkill("cli/cli-skill/SKILL.md", "name: cli-skill");
    const r = await loadSkills({ ...baseOpts, noSkills: true, cliSkills: [cliSkill] });
    const names = r.skills.map((s) => s.name);
    expect(names).not.toContain("gone");
    expect(names).toContain("cli-skill");
    // cliSkill path may be a file or its containing dir
    expect(r.skills.find((s) => s.name === "cli-skill")?.source).toBe("cli");
  });

  it("accepts a containing dir for --skill", async () => {
    await writeSkill("cli2/dir-skill/SKILL.md", "name: dir-cli-skill\ndescription: D.");
    const r = await loadSkills({ ...baseOpts, cliSkills: [path.join(tmp, "cli2")] });
    expect(r.skills.map((s) => s.name)).toContain("dir-cli-skill");
  });

  it("keeps the first skill on a name collision and warns", async () => {
    await writeSkill("home/.tiny-cli/agent/skills/dupe/SKILL.md", "name: dupe\ndescription: First.");
    const second = await writeSkill("extra/dupe2/SKILL.md", "name: dupe\ndescription: Second.");
    const r = await loadSkills({ ...baseOpts, settingsSkills: [second] });
    expect(r.skills.filter((s) => s.name === "dupe")).toHaveLength(1);
    expect(r.skills.find((s) => s.name === "dupe")?.source).toBe("global");
    expect(r.warnings.some((w) => w.message.includes('duplicate skill name "dupe"'))).toBe(true);
  });

  it("lets a user skill override the bundled create-skill", async () => {
    const mine = await writeSkill("home/.tiny-cli/agent/skills/create-skill/SKILL.md", "name: create-skill");
    const r = await loadSkills(baseOpts);
    expect(r.skills.find((s) => s.name === "create-skill")?.path).toBe(mine);
  });

  it("drops skills with a missing description and warns", async () => {
    await writeSkill("home/.tiny-cli/agent/skills/nodesc/SKILL.md", "name: nodesc\ndescription:");
    const r = await loadSkills(baseOpts);
    expect(r.skills.map((s) => s.name)).not.toContain("nodesc");
    expect(r.warnings.some((w) => w.message.includes("no description"))).toBe(true);
  });
});
