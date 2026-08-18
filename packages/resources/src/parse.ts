import type { SkillWarning } from "./types.js";

/**
 * Parse a simple `key: value` frontmatter block delimited by leading `---` lines.
 * No YAML dependency. Returns {} when there is no frontmatter block.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const fm: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") return fm; // closing marker
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm; // no closing marker found — treat whatever parsed as frontmatter
}

/**
 * Validate frontmatter for a skill file.
 * - fatal (skill not loaded): missing/empty description
 * - warnings: name issues (length, chars, hyphens), description > 1024 chars
 * - name missing: defaults to file/dir name (warning)
 * - name != directory name: allowed silently (documented deviation)
 * - allowed-tools, license, compatibility, metadata: accepted, ignored
 * - unknown fields: ignored, no warning
 */
export function validateSkill(
  fm: Record<string, string>,
  path: string
): { warnings: SkillWarning[]; fatal: string | null; name: string } {
  const warnings: SkillWarning[] = [];
  const description = (fm.description ?? "").trim();

  if (!description) {
    return {
      warnings: [{ path, message: `skill at ${path} has no description; it will not be loaded` }],
      fatal: "missing or empty description",
      name: "",
    };
  }

  if (description.length > 1024) {
    warnings.push({ path, message: `description exceeds 1024 characters (${description.length})` });
  }

  let name = (fm.name ?? "").trim();
  if (!name) {
    name = defaultName(path);
    warnings.push({ path, message: `skill at ${path} has no name; defaulting to "${name}"` });
  } else if (name.length > 64) {
    warnings.push({ path, message: `name exceeds 64 characters: "${name.slice(0, 20)}..."` });
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    warnings.push({
      path,
      message: `name "${name}" should be lowercase a-z, 0-9, hyphens only, without leading/trailing/consecutive hyphens`,
    });
  }

  return { warnings, fatal: null, name };
}

/** Derive a skill name from the file path: SKILL.md -> parent dir name; foo.md -> foo. */
export function defaultName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (last.toLowerCase() === "skill.md") {
    return parts[parts.length - 2] ?? "skill";
  }
  return last.replace(/\.md$/i, "");
}
