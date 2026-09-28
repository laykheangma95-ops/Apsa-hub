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
import { ZodError } from "zod";
import { formatInternalErrorMessage } from "@/lib/public-error";
import {
  PublicDomainError,
  isPublicDomainError as isApsaPublicDomainError,
} from "@/server/public-domain-error";
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

/**
 * The text of an error-like value: an Error's message, a thrown string, or a
 * provider error object's `message` (PostgrestError / AuthError are plain
 * objects in some code paths). Always scrubbed by the caller before logging.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error != null && typeof error === "object") {
    const { message } = error as { message?: unknown };
    if (typeof message === "string") return message;
  }
  return "";
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
    errorMessage: scrubString(messageOf(error), 300),
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
 * An error whose message and status may reach the browser verbatim:
 *
 *   - an APSA public domain error — created deliberately by APSA service code
 *     through src/server/public-domain-error.ts (publicError(), a
 *     PublicDomainError, or a domain error class that marks itself). Provenance
 *     is a registry membership, NOT the presence of a numeric `statusCode`;
 *   - a zod validation failure (a real ZodError instance) raised by an APSA
 *     input validator — it describes the caller's own input.
 *
 * Anything else — a repository error quoting PostgREST/SQL text, a supabase-js
 * AuthError, an h3/fetch/provider error that carries `statusCode`/`status`/
 * `code`, a thrown string, a TypeError — is NOT public, whatever fields it has.
 */
export function isPublicDomainError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  return isApsaPublicDomainError(error);
}

/**
 * The error the browser receives for an unexpected failure: a fixed message
 * plus the support reference. No stack, no SQL, no table/constraint names, no
 * secret names. Marked public so an enclosing boundary passes it unchanged.
 */
export function toPublicInternalError(requestId: string): Error {
  const error = new PublicDomainError(formatInternalErrorMessage(requestId), 500, "internal_error");
  error.name = "InternalServerError";
  return Object.assign(error, { requestId });
}
