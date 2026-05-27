import { LogLevel } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, LOG: 2, ERROR: 3 };

let _logLevel: LogLevel = 'LOG';

export function setLogLevel(level: LogLevel) {
  _logLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[_logLevel];
}

export function logTrace(msg: string) {
  if (shouldLog('TRACE')) console.log(`[TRACE] ${new Date().toISOString()} ${msg}`);
}

export function logDebug(msg: string) {
  if (shouldLog('DEBUG')) console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`);
}

export function logError(msg: string) {
  if (shouldLog('ERROR')) console.error(`[ERROR] ${new Date().toISOString()} ${msg}`);
}
