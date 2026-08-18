---
name: create-skill
description: Scaffold a new agent skill (directory, SKILL.md with frontmatter, optional scripts/references/assets). Use when the user asks to create, build, or add a skill.
---

# Create Skill

Scaffold a new agent skill for the user. Follow this procedure end to end.

## Setup

1. Gather the requirements — but YOU author the skill, never the user. The
   user gives intent ("a skill that writes test cases"); you write the full
   SKILL.md body yourself. Do NOT ask the user for file content, frontmatter,
   or structure, and do NOT call `write` without a complete `content` string.
   You want to know:
   - What the skill should do and when it should trigger (this becomes the
     `description` — the model only sees name + description, so write a
     concrete "what it does + when to use it" sentence). If the user gave
     only a name (e.g. description equals the name), infer the purpose from
     the name and the conversation — do not interrogate the user. Ask at most
     one clarifying question, and only when the purpose is truly unguessable.
   - Where it should live: project skill (`.tiny-cli/skills/`, shared via the
     repo) or global skill (`~/.tiny-cli/agent/skills/`, personal). Default to
     project when the user is working inside a repo and does not say.
   - A name if the user has one in mind; otherwise you will derive it.
2. Derive the name (skip if the user gave one):
   - Take the first few meaningful words of the description, lowercase them,
     replace spaces with hyphens, strip characters outside `a-z0-9-`.
   - Constraints: 1-64 chars, lowercase `a-z`, `0-9`, hyphens only; no leading,
     trailing, or consecutive hyphens. Fix up until valid (e.g. `pdf processing!`
     -> `pdf-processing`).

## Usage

3. Create the skill with the `create_skill` tool. It takes `name`,
   `description`, `body` (the Markdown procedure you authored) and an optional
   `location` ('project' | 'global'). Do NOT hand-write SKILL.md with `write` —
   `create_skill` composes the frontmatter and validates the name for you:

   ```
   <locationDir>/<name>/SKILL.md
   ```

   - Frontmatter must contain exactly `name:` and `description:`. Keep the
     description under 1024 characters.
   - The body is a Markdown procedure for an agent to follow, not user docs.
     Start with `# <Title>`, then short sections the agent executes in order
     (`## Setup`, `## Usage`, ...). Be imperative and specific: file paths,
     commands, decision rules. Keep it minimal — every line should earn its
     place; do not pad with boilerplate.
4. Add supporting files ONLY if the skill genuinely needs them. Do not create
   empty directories:
   - `scripts/` — executable helper scripts the skill instructs the agent to run.
   - `references/` — longer documentation the agent reads on demand; keep the
     procedure in SKILL.md short and point here for detail.
   - `assets/` — templates and other static files.
   Reference every supporting file from SKILL.md using relative paths
   (e.g. `scripts/build.sh`, `references/api-notes.md`).
5. Validate the result:
   - `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is 1-64 chars.
   - `description` is present, under 1024 chars, and states when to use the skill.
   - Frontmatter block is delimited by `---` lines and parses as `key: value`.
   - Every relative path mentioned in SKILL.md exists on disk.
6. Report to the user: the skill directory created, the name, the description,
   and the list of supporting files. Tell them the skill is picked up on the
   next session (or immediately via discovery).
