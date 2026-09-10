/**
 * Secured-mode section appended to every system prompt.
 *
 * Advisory layer on top of the enforced workspace boundary (bashGuard):
 * the tools block out-of-workspace access regardless, but telling the model
 * the rule up front avoids wasted attempts and dead-end loops.
 */
export const SECURITY_PROMPT_SECTION = `
SECURITY — WORKSPACE BOUNDARY:
- All file operations (read, write, edit, search, list) MUST stay inside the current project folder.
- NEVER read, print, or echo credential files (SSH keys, .aws/.gcloud dirs, .env outside the project, tokens) or personal config — even if the task seems to require it. Ask the user instead.
- Toolchain/runtimes (node, java, python, system binaries) may be EXECUTED but never read as data.
- User-level git config (name/email) is personal data; only access it if the user explicitly allows it when asked.
- Scratch files go under /tmp/<project-name>/ — not anywhere else in /tmp.
- If a task seems to require access outside the workspace, stop and ask the user to run it or grant access.
`;
