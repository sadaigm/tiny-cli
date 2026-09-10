import fs from 'fs';
import path from 'path';
import os from 'os';
import { LogLevel } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, LOG: 2, ERROR: 3 };

let _logLevel: LogLevel = 'LOG';

// Every log line (any level) is appended to this file, so the TUI can stay
// clean on screen while failures are still observable via `tail -f`.
// Project-local (matches sessions/plan storage) — falls back to the home
// dir when cwd isn't writable.
function logFilePath(): string {
  const project = path.join(process.cwd(), '.tiny-cli', 'tui.log');
  try {
    fs.mkdirSync(path.dirname(project), { recursive: true });
    return project;
  } catch {
    return path.join(os.homedir(), '.tiny-cli', 'tui.log');
  }
}

function appendToFile(line: string) {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch {
    // Logging must never crash the app.
  }
}

export function setLogLevel(level: LogLevel) {
  _logLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[_logLevel];
}

// Pristine console methods, saved at module load — before the TUI's
// useConsoleCapture overrides console.* (which would otherwise route the
// logger's own ERROR output back into logError → infinite recursion).
const origConsoleError = console.error;
const origConsoleLog = console.log;

function emit(level: LogLevel, msg: string) {
  const line = `[${level}] ${new Date().toISOString()} ${msg}`;
  // VERBOSE (TRACE/DEBUG) lines land in the file only when the level
  // allows; LOG/ERROR always — failures must never be filtered away.
  if (shouldLog(level) || LEVEL_ORDER[level] >= LEVEL_ORDER['LOG']) {
    appendToFile(line);
  }
  if (shouldLog(level)) {
    if (level === 'ERROR') origConsoleError(line);
    else origConsoleLog(line);
  }
}

export function logTrace(msg: string) {
  emit('TRACE', msg);
}

export function logDebug(msg: string) {
  emit('DEBUG', msg);
}

/** Normal-operation info (default level) — e.g. LLM connection lifecycle. */
export function logInfo(msg: string) {
  emit('LOG', msg);
}

export function logError(msg: string) {
  emit('ERROR', msg);
}
