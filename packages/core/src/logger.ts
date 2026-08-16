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

function emit(level: LogLevel, msg: string) {
  const line = `[${level}] ${new Date().toISOString()} ${msg}`;
  appendToFile(line);
  if (shouldLog(level)) {
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  }
}

export function logTrace(msg: string) {
  emit('TRACE', msg);
}

export function logDebug(msg: string) {
  emit('DEBUG', msg);
}

export function logError(msg: string) {
  emit('ERROR', msg);
}
