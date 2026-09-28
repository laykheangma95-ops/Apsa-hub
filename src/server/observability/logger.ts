/**
 * Structured server logging.
 *
 * Every line is ONE JSON object on ONE line, written through the platform's
 * console (Vercel / Cloudflare / Node all capture stdout/stderr into their log
 * pipelines). Fields are fixed and machine-searchable:
 *
 *   ts, level, event, requestId, domain, operation,
 *   organizationId, userId, errorClass, errorCode, statusCode, retryable,
 *   plus any extra operational fields the caller passes.
 *
 * Everything passes through redact() first, so a caller that accidentally
 * hands over a password, token, cookie, email or phone number gets
 * "[REDACTED]" in the log, not the value. Callers should still pass IDs and
 * codes only — redaction is the backstop, not the design.
 *
 * Server-only. Never import this from browser-bundled code.
 */
import { redactFields, scrubString } from "./redact";
import { currentRequestContext } from "./request-context";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  domain?: string;
  operation?: string;
  /** Tenant ID. An opaque UUID — safe to log; never a name or slug. */
  organizationId?: string;
  /** Member ID. An opaque UUID — safe to log; never an email. */
  userId?: string;
  errorClass?: string;
  errorCode?: string;
  statusCode?: number;
  retryable?: boolean;
  [extra: string]: unknown;
}

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  // A plain string argument: src/lib/error-capture.ts only rewrites Error
  // arguments, so the JSON line reaches the log pipeline untouched.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

let sink: LogSink = defaultSink;

/** Test hook — capture log lines instead of writing them. Returns a restore fn. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function buildLogRecord(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
  now: Date = new Date(),
): Record<string, unknown> {
  const context = currentRequestContext();
  return {
    ts: now.toISOString(),
    level,
    event: scrubString(event, 120),
    ...redactFields({
      ...(context?.requestId ? { requestId: context.requestId } : {}),
      ...(context?.domain ? { domain: context.domain } : {}),
      ...(context?.operation ? { operation: context.operation } : {}),
      ...fields,
    }),
  };
}

export function logServerEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    sink(level, JSON.stringify(buildLogRecord(level, event, fields)));
  } catch {
    // Logging must never break the operation it describes.
  }
}

export const serverLog = {
  debug: (event: string, fields?: LogFields) => logServerEvent("debug", event, fields),
  info: (event: string, fields?: LogFields) => logServerEvent("info", event, fields),
  warn: (event: string, fields?: LogFields) => logServerEvent("warn", event, fields),
  error: (event: string, fields?: LogFields) => logServerEvent("error", event, fields),
};
