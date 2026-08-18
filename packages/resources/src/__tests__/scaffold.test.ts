import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldSkill } from "../scaffold.js";
import { parseFrontmatter } from "../parse.js";

let tmp = "";
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = "";
});

async function tmpDir(): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-"));
  return tmp;
}

describe("scaffoldSkill", () => {
  it("creates the skill dir and SKILL.md with correct frontmatter", async () => {
    const dir = await tmpDir();
    const { skillDir, files } = await scaffoldSkill({
      name: "demo-skill",
      description: "Demo skill.",
      locationDir: dir,
    });
    expect(skillDir).toBe(path.join(dir, "demo-skill"));
    expect(files).toEqual([path.join(skillDir, "SKILL.md")]);
    const content = await fs.readFile(files[0], "utf8");
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe("demo-skill");
    expect(fm.description).toBe("Demo skill.");
    expect(content).toContain("# Demo Skill");
    expect(content).toContain("## Setup");
    expect(content).toContain("## Usage");
  });

  it("creates extras directories when requested and not otherwise", async () => {
    const dir = await tmpDir();
    const r = await scaffoldSkill({
      name: "with-extras",
      description: "d",
      locationDir: dir,
      extras: ["scripts", "references", "assets"],
    });
    for (const e of ["scripts", "references", "assets"]) {
      const st = await fs.stat(path.join(r.skillDir, e));
      expect(st.isDirectory()).toBe(true);
    }

    const bare = await scaffoldSkill({ name: "bare-skill", description: "d", locationDir: dir });
    const entries = await fs.readdir(bare.skillDir);
    expect(entries).toEqual(["SKILL.md"]);
  });

  it("uses the provided body verbatim", async () => {
    const dir = await tmpDir();
    const r = await scaffoldSkill({
      name: "custom-body",
      description: "d",
      locationDir: dir,
      body: "# Custom\n\nMy procedure.",
    });
    const content = await fs.readFile(path.join(r.skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("# Custom\n\nMy procedure.");
  });

  it("rejects invalid names", async () => {
    const dir = await tmpDir();
    for (const name of ["Bad_Name", "-lead", "trail-", "dou--ble", "UPPER", "", "x".repeat(65)]) {
      await expect(
        scaffoldSkill({ name, description: "d", locationDir: dir })
      ).rejects.toThrow(/invalid skill name/);
    }
  });

  it("rejects an existing directory", async () => {
    const dir = await tmpDir();
    await scaffoldSkill({ name: "dup", description: "d", locationDir: dir });
    await expect(
      scaffoldSkill({ name: "dup", description: "d", locationDir: dir })
    ).rejects.toThrow(/already exists/);
  });
});
