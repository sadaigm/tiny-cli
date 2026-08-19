import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadInstructions, MAX_INSTRUCTION_CHARS } from "../instructions.js";

describe('loadInstructions', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = `/tmp/tiny-cli-test-${Date.now()}`;
    await fs.mkdir(tempDir, { recursive: true });
    homeDir = path.join(tempDir, 'home');
    await fs.mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const fullPath = path.join(tempDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  // 1. Only CLAUDE.md → one block
  it('loads CLAUDE.md when present', async () => {
    await writeFile('cwd/CLAUDE.md', 'Project instructions');
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toContain('CLAUDE.md');
    expect(blocks[0].content).toBe('Project instructions');
  });

  // 2. Only AGENTS.md → fallback used
  it('loads AGENTS.md as fallback when CLAUDE.md absent', async () => {
    await writeFile('cwd/AGENTS.md', 'Agent instructions');
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toContain('AGENTS.md');
    expect(blocks[0].content).toBe('Agent instructions');
  });

  // 3. Both → CLAUDE.md wins, AGENTS.md ignored
  it('prefers CLAUDE.md over AGENTS.md when both present', async () => {
    await writeFile('cwd/CLAUDE.md', 'CLAUDE content');
    await writeFile('cwd/AGENTS.md', 'AGENTS content');
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toContain('CLAUDE.md');
    expect(blocks[0].content).toBe('CLAUDE content');
  });

  // 4. None → []
  it('returns empty array when no instruction files exist', async () => {
    await fs.mkdir(path.join(tempDir, 'cwd'), { recursive: true });
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(0);
  });

  // 5. User-global + project → both blocks, user-global first
  it('loads both user-global and project instructions in order', async () => {
    await writeFile('home/.tiny-cli/CLAUDE.md', 'User global instructions');
    await writeFile('cwd/CLAUDE.md', 'Project instructions');
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toContain('home');
    expect(blocks[0].content).toBe('User global instructions');
    expect(blocks[1].source).toContain('cwd');
    expect(blocks[1].content).toBe('Project instructions');
  });

  // 6. CLAUDE.local.md → appended last
  it('loads CLAUDE.local.md as third block', async () => {
    await writeFile('home/.tiny-cli/CLAUDE.md', 'User global');
    await writeFile('cwd/CLAUDE.md', 'Project');
    await writeFile('cwd/CLAUDE.local.md', 'Local overrides');
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].source).toContain('home');
    expect(blocks[1].source).toContain('cwd/CLAUDE.md');
    expect(blocks[2].source).toContain('CLAUDE.local.md');
    expect(blocks[2].content).toBe('Local overrides');
  });

  // 7. Oversized file → truncated with notice
  it('truncates oversized file and adds notice', async () => {
    const longContent = 'x'.repeat(MAX_INSTRUCTION_CHARS + 1000);
    await writeFile('cwd/CLAUDE.md', longContent);
    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content.length).toBe(MAX_INSTRUCTION_CHARS + '\n[...truncated...]'.length);
    expect(blocks[0].content).toContain('[...truncated...]');
  });

  // 8. Unreadable file (chmod 000) → level skipped, no throw
  it('skips unreadable files without throwing', async () => {
    await writeFile('cwd/CLAUDE.md', 'Content');
    const filePath = path.join(tempDir, 'cwd/CLAUDE.md');
    await fs.chmod(filePath, 0o000);

    const blocks = await loadInstructions(path.join(tempDir, 'cwd'), homeDir);
    expect(blocks).toHaveLength(0);

    // Restore permissions for cleanup
    await fs.chmod(filePath, 0o644);
  });
});
