import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { ToolDefinition } from '../../types.js';
import { logDebug } from '../../logger.js';
import { ToolRegistry } from '../registry.js';
import { checkBashRedirect, recordRedirectCount } from '../bashRedirect.js';
import { checkBashBoundary } from '../bashGuard.js';
import { wrapBashCmd } from '../execTarget.js';

export function register(registry: ToolRegistry) {
  // bash
  const bashDef: ToolDefinition = {
    name: 'bash',
    description: [
      'Execute a shell command in your environment (runs through /bin/sh).',
      '',
      'How to use:',
      '1. Provide a single `cmd` string. It may chain multiple commands with && ; and pipes |.',
      '2. The FULL combined stdout+stderr of every segment is returned, even if a segment exits non-zero.',
      '3. Non-zero exit is NOT treated as a tool failure — read the output to judge success.',
      '',
      'TOOL ROUTING (strict): use bash ONLY for real shell work — git, build, test, install,',
      'process/file management, pipelines between programs. NEVER use bash to read, search,',
      'locate, or edit files. Plain single-purpose cat/head/tail/grep/find/ls/sed/echo> commands',
      'are intercepted and NOT executed. Use the dedicated tools instead:',
      '  read a file -> `read` | search contents -> `grep` | find by name -> `glob`',
      '  list a dir -> `list` | edit a file -> `search_replace` | create/rewrite -> `write`',
      '',
      'This is a mutating tool (guarded by the permission system).',
      '',
      'WORKSPACE BOUNDARY (secured mode): file operations must stay inside the',
      'project folder. Reading/writing outside it, reading toolchain/runtime',
      'files as data, and touching credentials are blocked; user-level git',
      'config (name/email) requires user consent. Scratch space: /tmp/<project>/',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The shell command(s) to execute; may chain with && ; |' }
      },
      required: ['cmd']
    },
    isModifying: true
  };
  registry.register(bashDef, async (args, context) => {
    let command = args.cmd;
    if (typeof command !== 'string' || !command.trim()) {
      return 'Tool error: cmd must be a shell command string.';
    }
    // Runtime tool-routing enforcement: a plain cat/grep/find/ls/sed/echo>
    // duplicates a dedicated tool (and sed -i / echo > mutate files invisibly),
    // so refuse it with a redirect instead of executing.
    const redirectResult = checkBashRedirect(command);
    if (redirectResult) {
      recordRedirectCount(redirectResult.key);
      logDebug(`[tool-redirect] ${redirectResult.key}: ${command.trim()}`);
      return redirectResult.message;
    }
    // Workspace boundary enforcement: file operations stay inside the
    // project folder; toolchain binaries execute but never read as data;
    // credentials hard-block; git identity needs user consent.
    if (context?.securedMode !== false) {
      // Boundary anchor: local profiles anchor to the host project dir.
      // Exec-target profiles anchor to the TARGET's path space instead — the
      // model's commands carry container/remote paths (/data/...), which are
      // meaningless against the host cwd (they'd all look "outside" and be
      // blocked). With a root, confinement is the target workspace; without
      // one (bash-only), the container/host itself is the sandbox, so no
      // path confinement beyond the other boundary rules.
      const boundaryRoot = context?.execTarget
        ? (context.execTarget.root ?? '/')
        : (context?.cwd || process.cwd());
      const boundary = await checkBashBoundary(command, boundaryRoot, context?.askUser);
      if (boundary) {
        logDebug(`[bash-guard] ${boundary.key}: ${command.trim()}`);
        return boundary.message;
      }
    }
    return new Promise((resolve) => {
      // Branch 1 — exec-target profile: wrap the command for the container/
      // ssh host (design §4 edges E/F). Branch 2 — local profile: run the
      // command unchanged (design §4 edge C, byte-identical). Either way the
      // redirect/boundary checks above saw the raw model command (intent),
      // and the output contract below is identical for both branches.
      const wrapped = context?.execTarget ? wrapBashCmd(context.execTarget, command) : command;
      // A non-zero exit is data, not a tool failure: chains like
      // `cd X && ls missing-file` should surface BOTH the successful echo
      // output AND the ls stderr, so the model can read the whole picture
      // instead of bailing on the first failing segment. Only treat a total
      // inability to run (nothing on stdout/stderr, e.g. command not found)
      // as a genuine error. stdout and stderr are merged like a real shell.
      exec(wrapped as string, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (combined) {
          resolve(combined);
        } else if (err) {
          resolve(`Error: ${err.message}`);
        } else {
          resolve('Command executed successfully (no output).');
        }
      });
    });
  });
}
