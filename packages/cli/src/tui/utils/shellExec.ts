import { exec } from 'child_process';
import { wrapBashCmd, type ExecTarget } from '@tiny-cli/core';

/**
 * Bang-mode (`! command`) helpers: parse `!`-prefixed input and run the
 * command through the same exec-target wrapping the bash tool uses.
 *
 * Unlike the model-facing bash tool, no redirect/boundary guards apply —
 * the user typed the command themselves.
 */

/** Command text when input is a bang line (`! cmd` / `!cmd`), else null. */
export function parseBangInput(text: string): string | null {
  if (!text.startsWith('!')) return null;
  const cmd = text.slice(1).trim();
  return cmd.length > 0 ? cmd : null;
}

export interface ShellResult {
  /** stdout+stderr merged and trimmed ('' when the command printed nothing). */
  output: string;
  /** Process exit code; non-zero failures still resolve, never reject. */
  exitCode: number;
}

/**
 * Run a shell command, locally or through the configured exec target
 * (docker/ssh), with the bash tool's semantics: /bin/sh, 10 MB buffer,
 * merged streams. A non-zero exit resolves with its code reported.
 */
export function runShellCommand(cmd: string, execTarget?: ExecTarget): Promise<ShellResult> {
  const wrapped = execTarget ? wrapBashCmd(execTarget, cmd) : cmd;
  return new Promise((resolve) => {
    exec(wrapped, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve({ output, exitCode: typeof err?.code === 'number' ? err.code : 0 });
    });
  });
}
