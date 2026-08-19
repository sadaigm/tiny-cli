import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstructionBlock {
  source: string;  // resolved file path, for debugging
  content: string; // file body (possibly truncated)
}

export const MAX_INSTRUCTION_CHARS = 20_000; // per file

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readWithTruncate(p: string): Promise<string> {
  try {
    let content = await fs.readFile(p, "utf-8");
    if (content.length > MAX_INSTRUCTION_CHARS) {
      content = content.slice(0, MAX_INSTRUCTION_CHARS) + "\n[...truncated...]";
    }
    return content;
  } catch {
    return "";
  }
}

async function loadFromLevel(primary: string, fallback?: string): Promise<InstructionBlock | null> {
  let target = primary;
  if (!await isFile(primary) && fallback) {
    target = fallback;
    if (!await isFile(target)) {
      return null;
    }
  }
  const content = await readWithTruncate(target);
  if (!content) return null;
  return { source: target, content };
}

export async function loadInstructions(
  cwd: string,
  home: string = process.env.HOME ?? os.homedir()
): Promise<InstructionBlock[]> {
  const blocks: InstructionBlock[] = [];

  // user-global level
  const userBlock = await loadFromLevel(
    path.join(home, ".tiny-cli", "CLAUDE.md"),
    path.join(home, ".tiny-cli", "AGENTS.md")
  );
  if (userBlock) blocks.push(userBlock);

  // project level
  const projectBlock = await loadFromLevel(
    path.join(cwd, "CLAUDE.md"),
    path.join(cwd, "AGENTS.md")
  );
  if (projectBlock) blocks.push(projectBlock);

  // local level (no fallback)
  const localBlock = await loadFromLevel(
    path.join(cwd, "CLAUDE.local.md")
  );
  if (localBlock) blocks.push(localBlock);

  return blocks;
}
