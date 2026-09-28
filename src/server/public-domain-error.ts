/**
 * APSA-owned public domain errors — the ONLY errors whose message and status
 * may cross the server-function boundary to the browser.
 *
 * Provenance, not shape: an error is public because APSA service code
 * deliberately created it through this module, never because it happens to
 * carry a numeric `statusCode`, `status` or `code`. supabase-js, PostgREST,
 * h3, fetch adapters and provider SDKs all attach such fields to errors whose
 * text can quote constraint names, table names, emails or row values; the
 * boundary sanitizes every one of them.
 *
 * The provenance mark is membership in a WeakSet that only this module's
 * functions write to. A property can be copied or set by accident; WeakSet
 * membership cannot — an error is marked only by calling publicError(),
 * constructing a PublicDomainError, or calling markPublicDomainError() from a
 * domain error class's constructor. Object.assign(publicErr, {...}) keeps the
 * mark (same object); wrapping or cloning an error drops it.
 *
 * The registry lives on globalThis under a Symbol.for key so a module that the
 * bundler happens to instantiate twice still shares one registry. Reaching it
 * requires deliberate code, which is exactly the provenance being attested.
 *
 * Dependency-free: safe to import from any server domain module.
 */

const REGISTRY_KEY = Symbol.for("apsa.publicDomainErrors");

function registry(): WeakSet<object> {
  const holder = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
  return (holder[REGISTRY_KEY] ??= new WeakSet<object>());
}

/**
 * Mark an error created by APSA domain code as safe to show the caller. Call
 * only from a constructor/factory whose message is written by APSA — never on
 * a caught error, whose text may be provider-authored.
 */
export function markPublicDomainError<E extends Error>(error: E): E {
  registry().add(error);
  return error;
}

export function isPublicDomainError(error: unknown): error is Error & { statusCode: number } {
  if (error == null || typeof error !== "object") return false;
  if (!registry().has(error)) return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

export class PublicDomainError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = "PublicDomainError";
    this.statusCode = statusCode;
    if (code) this.code = code;
    markPublicDomainError(this);
  }
}

/** A public domain error with an APSA-authored message. */
export function publicError(message: string, statusCode: number, code?: string): PublicDomainError {
  return new PublicDomainError(message, statusCode, code);
}
