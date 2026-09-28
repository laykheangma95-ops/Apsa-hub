/**
 * Error classification, error reporting and public-error sanitization.
 *
 * ── Error reporting (provider-neutral) ───────────────────────────────────────
 *
 * No error-monitoring provider (Sentry, OpenTelemetry, …) is configured for
 * APSA today, and none is invented here. reportServerError() always writes one
 * structured log line — the platform log pipeline is the baseline sink — and
 * additionally forwards a SANITIZED report to a registered ErrorReporter if
 * one exists. A future provider adapter implements ErrorReporter and is
 * registered once at server start; it only ever receives the same redacted
 * fields the log line carries, never the raw error object, request, cookies
 * or input.
 *
 * With no reporter registered the application behaves identically.
 *
 * Server-only. Never import this from browser-bundled code.
 */
import { formatInternalErrorMessage } from "@/lib/public-error";
import { serverLog, type LogFields } from "./logger";
import { scrubString } from "./redact";
import { currentRequestContext } from "./request-context";

// ── Classification ────────────────────────────────────────────────────────────

export function statusCodeOf(error: unknown): number | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
  const value = typeof statusCode === "number" ? statusCode : status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

/** Transient by nature: worth retrying as-is after a pause. */
export function isRetryable(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true;
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

const STACK_FRAME_LIMIT = 8;

/** Stack frames only (never the message line, which is logged scrubbed separately). */
function stackFramesOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  const frames = error.stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, STACK_FRAME_LIMIT)
    .map((line) => line.trim());
  return frames.length ? scrubString(frames.join(" | "), 1500) : undefined;
}

export interface ErrorDescription {
  errorClass: string;
  errorCode?: string;
  statusCode?: number;
  retryable: boolean;
  errorMessage: string;
  stack?: string;
}

export function describeErrorForLog(error: unknown): ErrorDescription {
  // A validation failure is the caller's bad input: a 400 in all but name.
  const statusCode =
    statusCodeOf(error) ?? (error instanceof Error && error.name === "ZodError" ? 400 : undefined);
  const errorCode = errorCodeOf(error);
  const stack = stackFramesOf(error);
  return {
    errorClass:
      error instanceof Error ? error.name || "Error" : error === null ? "null" : typeof error,
    ...(errorCode ? { errorCode } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    retryable: isRetryable(statusCode),
    errorMessage: scrubString(
      error instanceof Error ? error.message : typeof error === "string" ? error : "",
      300,
    ),
    ...(stack ? { stack } : {}),
  };
}

// ── Reporter registry ─────────────────────────────────────────────────────────

export interface SanitizedErrorReport extends ErrorDescription {
  event: string;
  requestId?: string;
  domain?: string;
  operation?: string;
  organizationId?: string;
  userId?: string;
}

export interface ErrorReporter {
  /** Short provider label for logs, e.g. "sentry". */
  readonly name: string;
  capture(report: SanitizedErrorReport): void | Promise<void>;
}

let reporter: ErrorReporter | null = null;

/** Register the (single) external error reporter. Pass null to remove it. */
export function registerErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

export function activeErrorReporterName(): string | null {
  return reporter?.name ?? null;
}

/**
 * Log an operationally important server error and forward it to the
 * registered reporter, if any. Never throws.
 */
export function reportServerError(
  error: unknown,
  fields: LogFields & { event?: string } = {},
): void {
  const { event = "server.error", ...rest } = fields;
  const description = describeErrorForLog(error);
  serverLog.error(event, { ...description, ...rest });

  if (!reporter) return;
  const context = currentRequestContext();
  const report: SanitizedErrorReport = {
    event,
    ...description,
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...(context?.domain ? { domain: context.domain } : {}),
    ...(context?.operation ? { operation: context.operation } : {}),
    ...(typeof rest.organizationId === "string" ? { organizationId: rest.organizationId } : {}),
    ...(typeof rest.userId === "string" ? { userId: rest.userId } : {}),
  };
  try {
    const pending = reporter.capture(report);
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      (pending as Promise<void>).catch(() => {
        serverLog.warn("error_reporter.capture_failed", { provider: reporter?.name });
      });
    }
  } catch {
    serverLog.warn("error_reporter.capture_failed", { provider: reporter.name });
  }
}

// ── Public errors ─────────────────────────────────────────────────────────────

/**
 * Control-flow values that must cross the boundary untouched: TanStack
 * redirects and not-found signals, and raw Responses.
 */
export function isControlFlowThrow(error: unknown): boolean {
  if (error instanceof Response) return true;
  if (error == null || typeof error !== "object") return false;
  return "isNotFound" in error || "isRedirect" in error;
}

/**
 * A domain error whose message was written by APSA service code for the
 * caller: every service/authorization/team/conversation error carries a
 * numeric statusCode. Validation failures (ZodError) describe the caller's own
 * input and are passed through as before.
 *
 * Anything else — a repository error quoting PostgREST/SQL text, a thrown
 * string, a TypeError — is NOT public.
 */
export function isPublicDomainError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ZodError") return true;
  // `statusCode` only — NOT `status`: provider errors (supabase-js AuthError,
  // PostgrestError) carry `status` with provider-authored text that must not
  // reach the browser verbatim.
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400 && status <= 599;
}

/**
 * The error the browser receives for an unexpected failure: a fixed message
 * plus the support reference. No stack, no SQL, no table/constraint names, no
 * secret names. statusCode 500 is set so an enclosing boundary treats it as
 * already public.
 */
export function toPublicInternalError(requestId: string): Error {
  return Object.assign(new Error(formatInternalErrorMessage(requestId)), {
    name: "InternalServerError",
    statusCode: 500,
    requestId,
  });
}
