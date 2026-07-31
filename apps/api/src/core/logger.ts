import { pino, type Logger as PinoLogger } from 'pino';
import type { LogLevel } from '@deedy/shared';
import type Database from 'better-sqlite3';

const SECRET_KEY_PATTERN = /(api[-_]?key|password|passwd|secret|token|authorization|cookie)/i;
const REDACTED = '[REDACTED]';

/** Recursively masks any value whose key looks like a credential. */
export function maskContext(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => maskContext(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : maskContext(val, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(scope: string, base?: LogContext): Logger;
  readonly scope: string;
}

export interface LoggerOptions {
  level: LogLevel;
  sqlite?: Database.Database;
  pretty?: boolean;
  /** Fan-out hook so the API can stream log lines over SSE. */
  onLog?: (entry: PersistedLog) => void;
}

export interface PersistedLog {
  level: LogLevel;
  scope: string;
  message: string;
  context: unknown;
  createdAt: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Structured logger that writes to stdout (pino) and durably to SQLite so the
 * dashboard can search history across restarts.
 */
export class AppLogger implements Logger {
  private readonly pinoLogger: PinoLogger;
  private readonly options: LoggerOptions;
  private readonly base: LogContext;
  private insertStatement: Database.Statement | null = null;

  constructor(options: LoggerOptions, scopeName = 'app', base: LogContext = {}, parent?: AppLogger) {
    this.options = options;
    this.scope = scopeName;
    this.base = base;
    this.pinoLogger =
      parent?.pinoLogger.child({ scope: scopeName }) ??
      pino({
        level: options.level,
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
      });
    this.insertStatement = parent?.insertStatement ?? null;
  }

  readonly scope: string;

  child(scopeName: string, base: LogContext = {}): Logger {
    return new AppLogger(
      this.options,
      `${this.scope}:${scopeName}`,
      { ...this.base, ...base },
      this,
    );
  }

  trace(message: string, context?: LogContext): void {
    this.write('trace', message, context);
  }
  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }
  fatal(message: string, context?: LogContext): void {
    this.write('fatal', message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.level]) return;
    const merged = { ...this.base, ...(context ?? {}) };
    const masked = maskContext(merged) as Record<string, unknown>;

    this.pinoLogger[level]({ ...masked, scope: this.scope }, message);

    const entry: PersistedLog = {
      level,
      scope: this.scope,
      message,
      context: Object.keys(masked).length > 0 ? masked : null,
      createdAt: new Date().toISOString(),
    };

    this.persist(entry);
    this.options.onLog?.(entry);
  }

  private persist(entry: PersistedLog): void {
    const sqlite = this.options.sqlite;
    if (!sqlite) return;
    try {
      this.insertStatement ??= sqlite.prepare(
        'INSERT INTO logs (level, scope, message, context, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      this.insertStatement.run(
        entry.level,
        entry.scope,
        entry.message,
        entry.context === null ? null : JSON.stringify(entry.context),
        entry.createdAt,
      );
    } catch (error) {
      // Never let logging take the process down.
      this.pinoLogger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'failed to persist log entry',
      );
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new AppLogger(options);
}
