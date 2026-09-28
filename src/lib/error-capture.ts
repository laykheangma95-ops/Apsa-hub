// Server-only. Imported once, first, by src/server.ts.
//
// Two jobs:
//
// 1. Capture the original Error for the CURRENT request, so server.ts can
//    report it when h3 has already swallowed the throw into a generic 500
//    Response ({"unhandled":true,"message":"HTTPError"}). The slot lives in the
//    per-request AsyncLocalStorage context (request-context.ts#capture), never
//    in module state: concurrent requests cannot read or consume each other's
//    errors, and an error raised outside any request is simply not captured.
//
// 2. Make every direct console.error / console.warn on the server a redacted
//    line. h3's internal unhandled-error logging, framework code and any
//    remaining legacy call site pass Errors, provider payloads and strings
//    straight to the console; without this wrapper their raw message, stack,
//    cause chain, SQL text or customer PII would reach the log pipeline. An
//    Error becomes a scrubbed { errorClass, errorCode, statusCode, errorMessage,
//    stack-frames } description; objects go through redact(); strings through
//    scrubString(). Structured lines from src/server/observability/logger.ts are
//    already redacted and pass untouched.

import { recordRequestError } from "@/server/observability/request-context";
import { redact, scrubString } from "@/server/observability/redact";

const STACK_FRAME_LIMIT = 8;
const LOGGED_STRING_LIMIT = 2_000;

/** A redacted, single-line description of an Error — no raw message, no cause chain. */
export function describeError(error: Error): string {
  const { statusCode, status, code } = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
  };
  const numericStatus =
    typeof statusCode === "number" ? statusCode : typeof status === "number" ? status : undefined;
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, STACK_FRAME_LIMIT)
    .map((line) => line.trim())
    .join(" | ");
  return JSON.stringify({
    errorClass: error.name || "Error",
    ...(typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { errorCode: code } : {}),
    ...(numericStatus !== undefined ? { statusCode: numericStatus } : {}),
    errorMessage: scrubString(error.message ?? "", 300),
    ...(frames ? { stack: scrubString(frames, 1500) } : {}),
  });
}

/** True for a line already produced (and redacted) by the structured logger. */
function isStructuredLogLine(value: string): boolean {
  return value.startsWith('{"ts":"');
}

export function sanitizeConsoleArg(arg: unknown): unknown {
  if (arg instanceof Error) return describeError(arg);
  if (typeof arg === "string") {
    return isStructuredLogLine(arg) ? arg : scrubString(arg, LOGGED_STRING_LIMIT);
  }
  if (arg !== null && typeof arg === "object") return redact(arg);
  return arg;
}

function wrap(original: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const sanitized = args.map((arg) => {
      if (arg instanceof Error) recordRequestError(arg);
      return sanitizeConsoleArg(arg);
    });
    original(...sanitized);
  };
}

console.error = wrap(console.error.bind(console));
console.warn = wrap(console.warn.bind(console));

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) =>
    recordRequestError((event as ErrorEvent).error ?? event),
  );
  globalThis.addEventListener("unhandledrejection", (event) =>
    recordRequestError((event as PromiseRejectionEvent).reason),
  );
}

export { consumeRequestError as consumeCapturedError } from "@/server/observability/request-context";
