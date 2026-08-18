import type { Skill } from "./types.js";

/**
 * Render the <available_skills> XML block for the system prompt.
 * Skills with invocationDisabled are omitted. Empty result → "".
 */
export function renderSkillsXml(skills: Skill[]): string {
  const usable = skills.filter((s) => !s.invocationDisabled);
  if (usable.length === 0) return "";
  const entries = usable
    .map(
      (s) =>
        `<skill>\n<name>${escapeXml(s.name)}</name>\n<description>${escapeXml(
          s.description
        )}</description>\n<location>${escapeXml(s.path)}</location>\n</skill>`
    )
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
