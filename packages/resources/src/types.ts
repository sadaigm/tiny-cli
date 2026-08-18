export type SkillSource = "global" | "project" | "agents" | "package" | "settings" | "cli";

export interface Skill {
  name: string; // frontmatter name
  description: string;
  path: string; // absolute path to SKILL.md / root .md
  source: SkillSource;
  invocationDisabled: boolean; // disable-model-invocation === true
}

export interface SkillWarning {
  path: string;
  message: string;
}

export interface SkillsResult {
  skills: Skill[];
  warnings: SkillWarning[];
}
