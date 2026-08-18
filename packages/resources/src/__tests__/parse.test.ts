import { describe, expect, it } from "vitest";
import { parseFrontmatter, validateSkill } from "../parse.js";

describe("parseFrontmatter", () => {
  it("parses a valid frontmatter block", () => {
    const fm = parseFrontmatter("---\nname: my-skill\ndescription: Does things.\n---\n\nBody.");
    expect(fm).toEqual({ name: "my-skill", description: "Does things." });
  });

  it("returns {} when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a doc\n\nno frontmatter")).toEqual({});
  });

  it("strips surrounding quotes from values", () => {
    const fm = parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---');
    expect(fm).toEqual({ name: "quoted", description: "single" });
  });

  it("stops at the closing delimiter", () => {
    const fm = parseFrontmatter("---\nname: a\n---\nname: b");
    expect(fm).toEqual({ name: "a" });
  });
});

describe("validateSkill", () => {
  it("accepts a valid skill with no warnings", () => {
    const r = validateSkill({ name: "good-skill", description: "d" }, "/x/good-skill/SKILL.md");
    expect(r.fatal).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.name).toBe("good-skill");
  });

  it("is fatal on missing description", () => {
    const r = validateSkill({ name: "x" }, "/x/SKILL.md");
    expect(r.fatal).toBe("missing or empty description");
    expect(r.warnings).toHaveLength(1);
  });

  it("is fatal on empty description", () => {
    const r = validateSkill({ name: "x", description: "   " }, "/x/SKILL.md");
    expect(r.fatal).not.toBeNull();
  });

  it("warns and defaults the name when missing", () => {
    const r = validateSkill({ description: "d" }, "/x/dir-skill/SKILL.md");
    expect(r.fatal).toBeNull();
    expect(r.name).toBe("dir-skill");
    expect(r.warnings).toHaveLength(1);
  });

  it("warns on name longer than 64 chars", () => {
    const name = "a".repeat(65);
    const r = validateSkill({ name, description: "d" }, "/x/SKILL.md");
    expect(r.fatal).toBeNull();
    expect(r.warnings.some((w) => w.message.includes("64"))).toBe(true);
  });

  it("warns on invalid name characters", () => {
    const r = validateSkill({ name: "Bad_Name", description: "d" }, "/x/SKILL.md");
    expect(r.warnings.some((w) => w.message.includes("lowercase"))).toBe(true);
  });

  it("warns on leading/trailing/consecutive hyphens", () => {
    for (const name of ["-x", "x-", "x--y"]) {
      const r = validateSkill({ name, description: "d" }, "/x/SKILL.md");
      expect(r.fatal).toBeNull();
      expect(r.warnings).toHaveLength(1);
    }
  });

  it("warns on description over 1024 chars", () => {
    const r = validateSkill({ name: "x", description: "d".repeat(1025) }, "/x/SKILL.md");
    expect(r.warnings.some((w) => w.message.includes("1024"))).toBe(true);
  });

  it("ignores allowed-tools/metadata/unknown fields silently", () => {
    const r = validateSkill(
      { name: "x", description: "d", "allowed-tools": "Bash", license: "MIT", whatever: "1" },
      "/x/SKILL.md"
    );
    expect(r.fatal).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});
