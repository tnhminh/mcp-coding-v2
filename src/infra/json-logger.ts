import type { LogLevel } from '../app/config.js';
import { AppError } from '../app/errors.js';

export type LogSink = (line: string) => void;
export type LogFields = Record<string, unknown>;

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitiveKey = /authorization|cookie|password|passwd|secret|token|api[_-]?key/i;

function sanitize(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitize(childValue, childKey);
    }
    return result;
  }
  return value;
}

function sanitizeFields(fields: LogFields): LogFields {
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = sanitize(value, key);
  }
  return result;
}

function errorFields(error: unknown): LogFields {
  if (error instanceof AppError) {
    return {
      error_name: error.name,
      error_code: error.code,
      error_message: error.expose ? error.message : 'Internal error',
    };
  }
  if (error instanceof Error) {
    return { error_name: error.name, error_message: 'Internal error' };
  }
  return { error_name: 'UnknownError', error_message: 'Non-Error value thrown' };
}

export class JsonLogger {
  constructor(
    private readonly minimumLevel: LogLevel = 'info',
    private readonly sink: LogSink = (line) => process.stderr.write(`${line}\n`),
  ) {}

  debug(event: string, message: string, fields: LogFields = {}): void {
    this.write('debug', event, message, fields);
  }

  info(event: string, message: string, fields: LogFields = {}): void {
    this.write('info', event, message, fields);
  }

  warn(event: string, message: string, fields: LogFields = {}): void {
    this.write('warn', event, message, fields);
  }

  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.write('error', event, 'Operation failed', { ...fields, ...errorFields(error) });
  }

  private write(level: LogLevel, event: string, message: string, fields: LogFields): void {
    if (severity[level] < severity[this.minimumLevel]) return;
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: 'mcp-coding-v2',
        event,
        message,
        fields: sanitizeFields(fields),
      }),
    );
  }
}
