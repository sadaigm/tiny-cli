/**
 * Workspace boundary enforcement for bash.
 *
 * The agent works inside a project folder; anything outside it is either the
 * toolchain (binaries/runtimes — fine to EXECUTE, never to read as data),
 * the user's own config (git identity — only with explicit consent), or none
 * of the agent's business (other projects, home dotfiles, system files).
 * Unrestricted `exec` silently sent all of that to the model provider.
 *
 * checkBashBoundary() classifies every path-like token in the command:
 *   - inside cwd                -> allow
 *   - toolchain path, executed  -> allow (program position only)
 *   - toolchain path, as operand of a file-op command -> block
 *   - git user-level config     -> ask the user (once per session if allowed)
 *   - secret/credential pattern -> hard block
 *   - anything else outside cwd -> block with guidance
 *
 * Not a sandbox: a determined script can still evade token analysis. This
 * stops the realistic cases — the model wandering outside the project — and
 * makes every excursion visible instead of silent.
 */

import { homedir } from 'os';
import * as fs from 'fs';
import path from 'path';
import type { AskUserPayload, AskUserResponse } from '../types.js';
import { tokenize } from './bashRedirect.js';

export type BashBoundaryResult = { key: string; message: string };

/** File-operation programs (read/write/create/dir/search categories). */
const FILE_OPS = new Set([
  // read/write single files
  'cat', 'head', 'tail', 'less', 'more', 'touch', 'cp', 'mv', 'rm', 'ln',
  'install', 'dd', 'shred', 'truncate', 'tee', 'split', 'join', 'wc',
  'md5sum', 'sha256sum', 'sha1sum', 'file', 'stat', 'basename', 'dirname',
  'realpath', 'readlink', 'cmp', 'diff',
  // create/modify content
  'sed', 'awk', 'vim', 'vi', 'nano', 'ed', 'patch', 'rsync', 'scp', 'sftp',
  // directory operations
  'ls', 'find', 'tree', 'du', 'df', 'mkdir', 'rmdir', 'cd', 'pushd',
  'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'zcat', 'bzip2', '7z', 'xz',
  // search
  'grep', 'rg', 'ag', 'ack', 'which', 'whereis', 'locate',
  // indirect file loads
  'source', 'xargs',
]);

/** Roots that hold the toolchain: executing from these is normal. */
const TOOLCHAIN_ROOTS = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/snap', '/etc/ssl/certs',
  '/etc/alternatives', '/proc', '/sys', '/dev',
].map((p) => p + '/');

const HOME_TOOLCHAIN = [
  '.nvm', '.pyenv', '.rbenv', '.cargo', '.rustup', '.sdkman', '.m2',
  '.gradle', '.conda', '.deno', '.bun', 'anaconda3', 'miniconda3',
  '.local', '.volta', '.go', '.gem',
].map((d) => path.join(homedir(), d) + '/');

/** Credential/secret patterns: never readable, no approval path. */
const SECRET_PATTERNS = [
  '.ssh/', '.aws/', '.gcloud/', '.gnupg/', '.kube/', '.docker/',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.netrc', '.npmrc',
  '.pypirc', 'credentials.db', 'credentials.json', 'service-account',
  '.pgpass', '.muttrc',
];

/** git config files/patterns that expose the user identity. */
const GIT_IDENTITY = [
  '.gitconfig', '.git-credentials', 'gitconfig --global', 'config --global',
];

/** Session-scoped allowances chosen by the user via the ask prompt. */
const sessionAllowed = new Set<string>();

function isUnder(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r.slice(0, -1) || p.startsWith(r));
}

/** Project-scoped scratch dir under /tmp (created on first use). Only this
 * subtree is allowed — not all of /tmp — so concurrent projects can't read
 * each other's scratch. Paths are `path.resolve`d before the prefix check,
 * so `/tmp/<proj>/../..` tricks collapse and get blocked. */
const scratchRoot = path.join('/tmp', path.basename(process.cwd())) + '/';

function inScratch(p: string): boolean {
  if (isUnder(p, [scratchRoot])) {
    try {
      fs.mkdirSync(scratchRoot, { recursive: true });
    } catch {
      // read-only fs or similar: the check stands, the command will fail
    }
    return true;
  }
  return false;
}

function looksLikePath(text: string): boolean {
  return text.startsWith('/') || text.startsWith('~/') || text === '~' ||
    text.startsWith('./') || text.startsWith('../') ||
    text.includes('/') || text.startsWith('$HOME');
}

/** Expand a token into an absolute path, or null if it isn't path-like. */
function toAbsolutePath(text: string, cwd: string): string | null {
  if (text.startsWith('$HOME')) {
    text = path.join(homedir(), text.slice('$HOME'.length));
  }
  if (text === '~') return homedir();
  if (text.startsWith('~/')) {
    text = path.join(homedir(), text.slice(2));
  }
  if (!looksLikePath(text)) {
    // bare word: relative filename -> resolves inside cwd
    return null;
  }
  return path.resolve(cwd, text);
}

function block(key: string, detail: string): BashBoundaryResult {
  return {
    key,
    message: [
      `WORKSPACE BOUNDARY: command NOT executed.`,
      detail,
      'File operations must stay inside the project folder. If you truly need ' +
        'this, ask the user to run it themselves or grant access.',
    ].join('\n'),
  };
}

function isSecret(p: string): boolean {
  const lower = p.toLowerCase();
  return SECRET_PATTERNS.some((s) => lower.includes(s));
}

function isGitIdentity(p: string, cmdLower: string): boolean {
  return GIT_IDENTITY.some((g) => p.includes(g) || cmdLower.includes(g));
}

async function askGitIdentity(
  askUser: ((p: AskUserPayload) => Promise<AskUserResponse>) | undefined,
  cmd: string,
): Promise<BashBoundaryResult | null> {
  const askKey = 'git-identity';
  if (sessionAllowed.has(askKey)) return null;
  if (askUser) {
    const res = await askUser({
      context: `This command reads your user-level git config (name/email): ${cmd.trim()}`,
      questions: [{
        question: 'Allow the agent to read your git identity?',
        options: ['Allow once', 'Allow for this session', 'Deny'],
      }],
    });
    if (res.kind === 'answered') {
      const choice = res.answers[0]?.selected;
      if (choice === 'Allow for this session') sessionAllowed.add(askKey);
      if (choice !== 'Deny') return null;
    }
  } else {
    // No interactive channel: deny rather than leak silently.
  }
  return block(
    'git-identity',
    'It reads user-level git config (your name/email), which is personal data.',
  );
}

/**
 * Classify a bash command against the workspace boundary.
 * Returns null to allow, or a result whose message the tool must return
 * instead of executing.
 */
export async function checkBashBoundary(
  cmd: string,
  cwd: string,
  askUser?: (p: AskUserPayload) => Promise<AskUserResponse>,
): Promise<BashBoundaryResult | null> {
  // Call sites that resolved a 'git-identity' sentinel swap it for the
  // interactive flow below.
  const resolve = async (r: BashBoundaryResult | null): Promise<BashBoundaryResult | null> =>
    r && r.key === 'git-identity' ? await askGitIdentity(askUser, cmd) : r;
  const cwdAbs = path.resolve(cwd) + '/';
  const cmdLower = cmd.toLowerCase();

  // Cheap global pre-scan: heredoc bodies and $(...) hide paths from the
  // tokenizer's operand view, but the raw string still shows them.
  const rawPaths: string[] = [];
  const homeRe = /(~\/[^\s'"`;|&<>]+|\$HOME[^\s'"`;|&<>]*)/g;
  let m: RegExpExecArray | null;
  while ((m = homeRe.exec(cmd))) rawPaths.push(m[1]);

  const tokens = tokenize(cmd);

  // Walk tokens; track whether the next non-flag token is a program name
  // (start of command, or after a metacharacter boundary like && ; | ).
  let programPosition = true;
  let program = '';

  for (const tok of tokens) {
    if (tok.unquotedMeta) {
      // e.g. "&&", "foo;", "(ls", "|grep" — strip shell metas and re-scan
      const parts = tok.text.split(/[|&;()<>`]+/).filter(Boolean);
      for (const part of parts) {
        const abs = toAbsolutePath(part, cwd);
        if (abs && !abs.startsWith(cwdAbs)) {
          const r = await resolve(classify(abs, programPosition, program, part, cmdLower));
          if (r) return r;
        }
      }
      // A command boundary (| ; && ;) means the next token is a program.
      // A pure redirection token (> >> <) means the NEXT token is a file
      // operand — treating it as a program would let `> /tmp/x` escape.
      const isCommandBoundary = /[|;()`]/.test(tok.text.replace(/2(?=>)/g, ''));
      if (isCommandBoundary) {
        programPosition = true;
        const last = parts[parts.length - 1];
        if (last) program = path.basename(last);
      }
      continue;
    }
    if (programPosition && !tok.text.startsWith('-')) {
      program = path.basename(tok.text);
      programPosition = false;
      // executing a toolchain binary is fine, but `bash /some/path` etc.
      // still scans as an operand below via looksLikePath on this token? No —
      // program tokens are not operands; allow and move on.
      const abs = toAbsolutePath(tok.text, cwd);
      if (abs && isSecret(abs)) {
        return block('secret', `It executes from a credential path: ${tok.text}`);
      }
      continue;
    }
    if (tok.text.startsWith('-')) continue; // flags
    // Operand position.
    const abs = toAbsolutePath(tok.text, cwd);
    if (abs && !abs.startsWith(cwdAbs)) {
      const r = await resolve(classify(abs, false, program, tok.text, cmdLower));
      if (r) return r;
    }
  }

  // Raw-string scan results (paths hidden inside heredocs/quotes).
  for (const raw of rawPaths) {
    const abs = toAbsolutePath(raw, cwd);
    if (abs && !abs.startsWith(cwdAbs)) {
      const r = await resolve(classify(abs, false, program, raw, cmdLower));
      if (r) return r;
    }
  }

  // git identity: `git config --global user.email` has no path-like token,
  // so the token walk never reaches classify() — check the command directly.
  if (GIT_IDENTITY.some((g) => cmdLower.includes(g))) {
    return await askGitIdentity(askUser, cmd);
  }

  return null;

  function classify(
    abs: string,
    isProgram: boolean,
    prog: string,
    original: string,
    cl: string,
  ): BashBoundaryResult | null {
    if (isSecret(abs)) {
      return block('secret', `It touches credentials/secrets: ${original}`);
    }
    if (!isProgram && inScratch(abs)) {
      return null; // project scratch subtree: allowed
    }
    if (!isProgram && isUnder(abs, ['/tmp/', '/var/tmp/', '/dev/shm/'])) {
      return {
        key: 'scratch-redirect',
        message: [
          `WORKSPACE BOUNDARY: only the project scratch directory is allowed, not all of /tmp.`,
          `Re-issue the command using: ${scratchRoot}`,
        ].join('\n'),
      };
    }
    if (isGitIdentity(abs, cl)) {
      // sentinel — caller swaps it for the interactive askGitIdentity flow
      return { key: 'git-identity', message: '' };
    }
    if (isProgram) return null; // executing a binary is not reading data
    if (isUnder(abs, TOOLCHAIN_ROOTS) || isUnder(abs, HOME_TOOLCHAIN)) {
      if (FILE_OPS.has(prog)) {
        return block(
          'toolchain-read',
          `It reads toolchain/runtime files as data (\`${prog} ${original}\`). ` +
            'Executing toolchain binaries is fine; reading their files is not.',
        );
      }
      return null; // operand of a non-file-op command (e.g. java -jar)
    }
    if (abs === homedir() || abs.startsWith(homedir() + '/')) {
      return block(
        'outside-workspace',
        `It accesses a file outside the project folder: ${original}`,
      );
    }
    return block(
      'outside-workspace',
      `It accesses a path outside the project folder: ${original}`,
    );
  }
}

/** Test hook. */
export function resetSessionAllowed(): void {
  sessionAllowed.clear();
}

/**
 * Sync path check for the dedicated file tools (read/grep/glob/write/...).
 * Returns null to allow, or an instructional message the tool must return
 * instead of file contents. Every path operand of those tools goes through
 * this — otherwise the model just bypasses the bash guard by switching tools.
 */
export function guardPath(p: string, cwd: string): string | null {
  const abs = toAbsolutePath(p, path.resolve(cwd));
  if (!abs) return null; // bare relative name -> inside cwd
  const cwdAbs = path.resolve(cwd) + '/';
  if (abs.startsWith(cwdAbs)) return null;
  if (isSecret(abs)) {
    return `WORKSPACE BOUNDARY: this path is credentials/secrets and is never readable: ${p}`;
  }
  if (isGitIdentity(abs, '')) {
    return `WORKSPACE BOUNDARY: user-level git config holds personal data (name/email) and is not readable: ${p}`;
  }
  if (inScratch(abs)) return null;
  return (
    `WORKSPACE BOUNDARY: path is outside the project folder and was NOT read: ${p}\n` +
    'File operations must stay inside the workspace (project scratch under ' +
    `${scratchRoot} is also allowed). Ask the user if you truly need outside access.`
  );
}
