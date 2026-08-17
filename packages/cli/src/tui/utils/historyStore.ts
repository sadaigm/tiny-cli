/**
 * Persistence for the input history.
 *
 * Entries live in a per-project JSON file under `~/.config/tiny-cli/`
 * (next to the global config), keyed by a stable hash of the project
 * root, so switching between workspaces keeps separate histories while
 * one file holds them all.
 *
 * The store is deliberately paranoid: any read/parse/write failure just
 * yields an empty history — losing recall across restarts is never worth
 * crashing the TUI over.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DEFAULT_HISTORY_LIMIT, InputHistory } from './inputHistory.js';

const HISTORY_DIR = path.join(os.homedir(), '.config', 'tiny-cli');
const HISTORY_FILE = path.join(HISTORY_DIR, 'input-history.json');

/** Upper bound on remembered projects, so the file stays small. */
const MAX_PROJECT_BUCKETS = 50;

/** Per-project bucket in the persisted file. */
interface HistoryFile {
  version: 1;
  projects: Record<string, string[]>;
}

/** Stable, filesystem-safe key for a directory path. */
function projectKey(dir: string): string {
  let hash = 0;
  for (let i = 0; i < dir.length; i++) {
    hash = (hash * 31 + dir.charCodeAt(i)) | 0;
  }
  // Signed 32-bit value, hex — same path always maps to the same bucket.
  return `${(hash >>> 0).toString(16)}-${path.basename(dir) || 'root'}`;
}

/** Overrides so tests can point the store at a temp dir. */
export interface HistoryStoreOptions {
  /** File to read/write (default: the shared `input-history.json`). */
  file?: string;
  /** Project whose bucket to load/save (default: `process.cwd()`). */
  projectDir?: string;
}

/** The bucket key for the current working directory. */
export function currentProjectKey(): string {
  return projectKey(process.cwd());
}

async function readAll(file: string): Promise<HistoryFile> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as HistoryFile;
    if (parsed && typeof parsed === 'object' && parsed.projects) return parsed;
  } catch {
    // Missing or corrupt file — start fresh.
  }
  return { version: 1, projects: {} };
}

/**
 * Load this project's history from disk into a live cursor.
 *
 * Corrupt or oversized files are truncated to the limit; failures resolve
 * to an empty history.
 */
export async function loadHistory(
  options: HistoryStoreOptions = {},
): Promise<InputHistory> {
  const history = new InputHistory();
  const file = await readAll(options.file ?? HISTORY_FILE);
  const key = projectKey(options.projectDir ?? process.cwd());
  const entries = file.projects[key];
  if (!Array.isArray(entries)) return history;
  for (const entry of entries) {
    if (typeof entry === 'string') history.push(entry);
  }
  return history;
}

/**
 * Persist this project's history, capping the bucket and the file.
 *
 * Fire-and-forget safe: callers don't need to await or handle errors —
 * a failed write only means the next launch recalls fewer lines.
 */
export async function saveHistory(
  history: InputHistory,
  options: HistoryStoreOptions = {},
): Promise<void> {
  const file = await readAll(options.file ?? HISTORY_FILE);
  const filePath = options.file ?? HISTORY_FILE;
  const key = projectKey(options.projectDir ?? process.cwd());
  try {
    const capped = history.toArray().slice(-DEFAULT_HISTORY_LIMIT);
    if (capped.length === 0) {
      delete file.projects[key];
    } else {
      file.projects[key] = capped;
    }
    // Drop buckets for projects that no longer keep any entries, and cap
    // the total file so decades of workspaces can't grow it unbounded.
    const keys = Object.keys(file.projects);
    if (keys.length > MAX_PROJECT_BUCKETS) {
      for (const key of keys.slice(0, keys.length - MAX_PROJECT_BUCKETS)) {
        delete file.projects[key];
      }
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(file), 'utf-8');
  } catch {
    // Unwritable config dir — persistence is best-effort.
  }
}
