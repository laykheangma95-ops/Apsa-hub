/**
 * Presentation rules for the Customer directory and Customer edit — pure,
 * browser-safe, testable without a DOM.
 *
 * Authorization is not decided here. The server requires `customers.read` for
 * every read, `customers.update_basic` for an edit, and
 * `customers.view_sensitive` before it reads, matches on or writes a phone
 * (src/server/customers/service.ts). This module only decides what the screen
 * may OFFER and SAY, and it always offers less than the server would allow,
 * never more.
 */

// ── Errors ────────────────────────────────────────────────────────────────────

export type CustomerErrorKind = "unauthorized" | "forbidden" | "not_found" | "invalid" | "error";

function statusCodeOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * One classification for every Customer read and write, so "you may not",
 * "it is not there", "that value is not valid" and "something failed" are four
 * different sentences on screen — and a failure is never shown as an empty
 * directory or a successful save.
 */
export function classifyCustomerError(err: unknown): CustomerErrorKind {
  const code = statusCodeOf(err);
  const message = err instanceof Error ? err.message : "";

  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 404) return "not_found";
  if (code === 400) return "invalid";

  // statusCode does not always survive the server-function boundary; fall
  // back to the service's own crafted messages.
  if (/not authenticated/i.test(message)) return "unauthorized";
  if (/missing permission|no active organization membership/i.test(message)) return "forbidden";
  if (/not found/i.test(message)) return "not_found";
  if (/cannot be empty|nothing to update|invalid|too_big|too_small|at most/i.test(message)) {
    return "invalid";
  }
  return "error";
}

// ── Directory ─────────────────────────────────────────────────────────────────

/** Rows per directory page. Within getCustomers()'s own 100-row cap. */
export const CUSTOMER_DIRECTORY_PAGE_SIZE = 50;

/** Long enough that a fast typist issues one request, short enough to feel live. */
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;

/**
 * What the directory body should say, in priority order. Each outcome is a
 * different sentence, because each means something different to a staff
 * member with a customer in front of them:
 *
 *   phone_denied — the query was a phone number and this member may not search
 *                  by phone. Nothing was searched; it is NOT "no such customer".
 *   partial_empty — a bounded phone scan stopped before the tenant's end and
 *                  matched nothing it reached. Also NOT "no such customer".
 *   no_results   — the search ran over everything it was allowed to and matched
 *                  nothing.
 *   empty        — this organization has no active customers yet.
 *   rows         — there is something to list.
 */
export type CustomerDirectoryBody =
  "phone_denied" | "partial_empty" | "no_results" | "empty" | "rows";

export function customerDirectoryBody(params: {
  searching: boolean;
  rowCount: number;
  phoneSearchDenied: boolean;
  truncated: boolean;
}): CustomerDirectoryBody {
  const { searching, rowCount, phoneSearchDenied, truncated } = params;
  if (searching && phoneSearchDenied) return "phone_denied";
  if (rowCount > 0) return "rows";
  if (searching && truncated) return "partial_empty";
  return searching ? "no_results" : "empty";
}

// ── Edit ──────────────────────────────────────────────────────────────────────

/** Mirrors updateCustomerFn's validator (src/api/customers.ts). The server re-checks. */
export const CUSTOMER_NAME_MAX_LENGTH = 200;
export const CUSTOMER_PHONE_MAX_LENGTH = 30;

export interface CustomerEditDraft {
  name: string;
  phone: string;
}

export interface CustomerEditCurrent {
  name: string;
  /** The phone as the server returned it — "" when absent OR withheld. */
  phone: string;
}

export type CustomerEditFieldError = "name_required" | "name_too_long" | "phone_too_long";

export interface CustomerEditPlan {
  /** Only what changed. Absent means "leave as it is"; `phone: null` removes it. */
  patch: { name?: string; phone?: string | null };
  errors: Partial<Record<keyof CustomerEditDraft, CustomerEditFieldError>>;
  /** True when there is something valid to send. */
  canSubmit: boolean;
  /** True when the draft removes a phone number that is currently on file. */
  removesPhone: boolean;
}

/**
 * Turn the edit form into the smallest honest request.
 *
 * `canEditPhone` must be the member's CURRENT, confirmed ability to see the
 * phone (both `canSensitive("customers.view_sensitive")` and the server's own
 * `sensitiveVisible`). When it is false the phone is never part of the patch,
 * whatever the draft says: a member who is shown "Hidden for your role" has no
 * current value to edit, and sending one would be a blind overwrite — which
 * the server refuses anyway.
 */
export function planCustomerEdit(params: {
  current: CustomerEditCurrent;
  draft: CustomerEditDraft;
  canEditPhone: boolean;
}): CustomerEditPlan {
  const { current, draft, canEditPhone } = params;
  const errors: CustomerEditPlan["errors"] = {};
  const patch: CustomerEditPlan["patch"] = {};

  const name = draft.name.trim();
  if (name.length === 0) errors.name = "name_required";
  else if (name.length > CUSTOMER_NAME_MAX_LENGTH) errors.name = "name_too_long";
  else if (name !== current.name.trim()) patch.name = name;

  let removesPhone = false;
  if (canEditPhone) {
    const phone = draft.phone.trim();
    if (phone.length > CUSTOMER_PHONE_MAX_LENGTH) errors.phone = "phone_too_long";
    else if (phone !== current.phone.trim()) {
      patch.phone = phone.length === 0 ? null : phone;
      removesPhone = phone.length === 0 && current.phone.trim().length > 0;
    }
  }

  const hasErrors = Object.keys(errors).length > 0;
  return {
    patch,
    errors,
    canSubmit: !hasErrors && Object.keys(patch).length > 0,
    removesPhone,
  };
}
