/**
 * Structured logger with request correlation IDs.
 * Outputs JSON lines — compatible with Supabase log drain / any log aggregator.
 */

export interface LogContext {
  request_id: string;
  user_id?: string;
  endpoint?: string;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (Deno.env.get("LOG_LEVEL") as LogLevel) ?? "info";

export class Logger {
  constructor(private ctx: LogContext) {}

  debug(msg: string, data?: Record<string, unknown>) {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>) {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>) {
    this.log("warn", msg, data);
  }
  error(msg: string, err?: unknown, data?: Record<string, unknown>) {
    const errData: Record<string, unknown> = { ...data };
    if (err instanceof Error) {
      errData.error_name = err.name;
      errData.error_message = err.message;
      if (err.cause) errData.error_cause = err.cause;
    } else if (err) {
      errData.error_raw = String(err);
    }
    this.log("error", msg, errData);
  }

  child(extra: Partial<LogContext>): Logger {
    return new Logger({ ...this.ctx, ...extra });
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.ctx,
      ...data,
    };

    // Use console methods so Supabase log drain picks them up
    const fn = level === "error" ? console.error
      : level === "warn" ? console.warn
      : console.log;
    fn(JSON.stringify(entry));
  }
}

export function createRequestId(): string {
  return crypto.randomUUID().slice(0, 12);
}
