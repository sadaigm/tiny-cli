import fs from 'fs/promises';
import path from 'path';
import fuzzy from 'fuzzy';

const DEFAULT_EXCLUDE_LIST = [
  'node_modules', '.turbo', 'dist', 'build', 'out', '.git',
  'target', '.mvn', 'vendor', '__pycache__', '.venv',
  '*.lock', 'pnpm-lock.yaml', 'package-lock.json',
  '*.class', '*.jar', '*.pyc', '.DS_Store', '.tiny-cli',
  '.tinyignore'
];

/**
 * Builds a flat list of relative file paths in the workspace.
 */
export async function buildFileIndex(root: string): Promise<string[]> {
  const files: string[] = [];
  
  // Load .tinyignore if it exists
  let customExcludes: string[] = [];
  try {
    const ignoreContent = await fs.readFile(path.join(root, '.tinyignore'), 'utf-8');
    customExcludes = ignoreContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (err) {
    // .tinyignore doesn't exist or is not readable, ignore
  }

  const combinedExcludes = [...DEFAULT_EXCLUDE_LIST, ...customExcludes];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const res = path.join(dir, entry.name);
      const relativePath = path.relative(root, res);

      // Check against exclude list
      const shouldExclude = combinedExcludes.some(pattern => {
        if (pattern.startsWith('*.')) {
          return entry.name.endsWith(pattern.slice(1));
        }
        // Handle directory patterns like 'dir/' or 'dir'
        const cleanPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
        const pathParts = relativePath.split(path.sep);
        return pathParts.includes(cleanPattern);
      });

      if (shouldExclude) continue;

      if (entry.isDirectory()) {
        await walk(res);
      } else {
        files.push(relativePath);
      }
    }
  }

  try {
    await walk(root);
  } catch (err) {
    console.error('Error building file index:', err);
  }
  return files;
}

/**
 * Fuzzy search files in the index.
 */
export function searchFiles(index: string[], query: string): string[] {
  const results = fuzzy.filter(query, index);
  return results.map(el => el.original).slice(0, 8);
}

/**
 * Hydrates a message by replacing [@path] tokens with actual file contents.
 */
export async function hydrateMessage(message: string): Promise<string> {
  const mentionRegex = /\[@([^\]]+)\]/g;
  let hydratedContent = '';
  const matches = [...message.matchAll(mentionRegex)];
  
  if (matches.length === 0) return message;

  const filesProcessed = new Set<string>();

  for (const match of matches) {
    const filePath = match[1];
    if (filesProcessed.has(filePath)) continue;

    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      console.log(`[Hydration] Injecting ${filePath} (${content.length} chars)`);
      hydratedContent += `<file path="${filePath}">\n${content}\n</file>\n\n`;
      filesProcessed.add(filePath);
    } catch (err) {
      console.warn(`[Hydration] Warning: Could not read file @${filePath}`);
    }
  }

  return hydratedContent + message;
}
