import fs from 'fs/promises';
import path from 'path';
import fuzzy from 'fuzzy';
import type { ImageAttachment, Message } from '@tiny-cli/core';

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
  return results.map(el => el.original).slice(0, 25);
}

/** Image extensions attachable via @mention, with their wire mime types. */
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** True when a mention target is an image file (by extension). */
export function isImagePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in IMAGE_MIME_TYPES;
}

/** Hard cap on a single attached image — larger files are skipped with a note. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface HydratedMessage {
  text: string;
  images: ImageAttachment[];
}

/**
 * Hydrates a message by replacing [@path] tokens with actual file contents.
 *
 * Text files are inlined as `<file>` blocks (as always); image mentions
 * become `ImageAttachment`s (base64) when the active model has vision —
 * their token in the text turns into `[image: path]`. Without vision (or
 * when the file is too large / unreadable) the image degrades to an
 * explicit skip note instead of binary garbage.
 */
export async function hydrateMessage(
  message: string,
  opts: { vision?: boolean } = {},
): Promise<HydratedMessage> {
  const mentionRegex = /\[@([^\]]+)\]/g;
  let hydratedContent = '';
  let text = message;
  const images: ImageAttachment[] = [];
  const matches = [...message.matchAll(mentionRegex)];

  if (matches.length === 0) return { text: message, images };

  const filesProcessed = new Set<string>();

  for (const match of matches) {
    const filePath = match[1];
    if (filesProcessed.has(filePath)) continue;
    filesProcessed.add(filePath);

    if (isImagePath(filePath)) {
      if (!opts.vision) {
        hydratedContent += `[image @${filePath} skipped — model has no vision]\n`;
        continue;
      }
      try {
        const fullPath = path.resolve(process.cwd(), filePath);
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_IMAGE_BYTES) {
          hydratedContent += `[image @${filePath} skipped — file too large (>5 MB)]\n`;
          continue;
        }
        const data = await fs.readFile(fullPath);
        images.push({
          path: filePath,
          mimeType: IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()],
          data: data.toString('base64'),
        });
        text = text.replaceAll(`[@${filePath}]`, `[image: ${filePath}]`);
        console.log(`[Hydration] Attaching image ${filePath} (${stat.size} bytes)`);
      } catch (err) {
        console.warn(`[Hydration] Warning: Could not read image @${filePath}`);
        hydratedContent += `[image @${filePath} missing — unreadable]\n`;
      }
      continue;
    }

    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      console.log(`[Hydration] Injecting ${filePath} (${content.length} chars)`);
      hydratedContent += `<file path="${filePath}">\n${content}\n</file>\n\n`;
    } catch (err) {
      console.warn(`[Hydration] Warning: Could not read file @${filePath}`);
    }
  }

  return { text: hydratedContent + text, images };
}

/**
 * Rebuild image attachments for a loaded session: persisted messages carry
 * path-only attachments (no base64, keeping session files small); re-read
 * each file from disk. A missing file drops the attachment and leaves an
 * explicit note in the text.
 */
export async function rehydrateSessionImages(messages: Message[]): Promise<Message[]> {
  const out: Message[] = [];
  for (const m of messages) {
    if (!m.images || m.images.length === 0) {
      out.push(m);
      continue;
    }
    const images: ImageAttachment[] = [];
    const missing: string[] = [];
    for (const img of m.images) {
      if (img.data) {
        images.push(img);
        continue;
      }
      try {
        const buf = await fs.readFile(path.resolve(process.cwd(), img.path));
        images.push({ ...img, data: buf.toString('base64') });
      } catch {
        missing.push(img.path);
      }
    }
    const notes = missing.map((p) => `\n[image @${p} missing]`).join('');
    const next: Message = { ...m, content: m.content + notes };
    if (images.length > 0) next.images = images;
    else delete next.images;
    out.push(next);
  }
  return out;
}
