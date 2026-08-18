import { describe, expect, it } from "vitest";
import { renderSkillsXml } from "../prompt.js";
import type { Skill } from "../types.js";

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "brave-search",
  description: "Web search and content extraction.",
  path: "/home/user/.tiny-cli/skills/brave-search/SKILL.md",
  source: "global",
  invocationDisabled: false,
  ...over,
});

describe("renderSkillsXml", () => {
  it("renders the available_skills wrapper with name/description/location", () => {
    const xml = renderSkillsXml([skill()]);
    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("<name>brave-search</name>");
    expect(xml).toContain("<description>Web search and content extraction.</description>");
    expect(xml).toContain("<location>/home/user/.tiny-cli/skills/brave-search/SKILL.md</location>");
    expect(xml.trim().endsWith("</available_skills>")).toBe(true);
  });

  it("excludes skills with invocationDisabled", () => {
    const xml = renderSkillsXml([skill(), skill({ name: "hidden", invocationDisabled: true })]);
    expect(xml).toContain("<name>brave-search</name>");
    expect(xml).not.toContain("hidden");
  });

  it("returns empty string for an empty or fully-disabled list", () => {
    expect(renderSkillsXml([])).toBe("");
    expect(renderSkillsXml([skill({ invocationDisabled: true })])).toBe("");
  });

  it("escapes XML special characters", () => {
    const xml = renderSkillsXml([skill({ name: "a<b", description: 'd & "e"' })]);
    expect(xml).toContain("<name>a&lt;b</name>");
    expect(xml).toContain("d &amp; &quot;e&quot;");
  });
});
