/**
 * The organization's selling currency (organizations.default_currency) — the
 * one currency every order is written in.
 *
 * The order RPC snapshots default_currency onto each order and refuses any
 * line whose variant is priced in another currency (`currency_mismatch`), so
 * a product priced in the wrong currency is a product that cannot be sold.
 *
 * Add Product therefore prices ONLY in the business currency, and only once
 * that currency is known for the organization the form is bound to:
 *
 *   - Unknown is never USD. While the lookup is pending, has failed, or is
 *     refused, there is no currency — and no amount field and no submit.
 *   - A response is accepted only for the organization it was asked for
 *     (verifyBusinessCurrency). A late reply answered for a different
 *     organization is rejected, not shown.
 *   - Entered amounts are bound to the organization + currency they were typed
 *     under (reconcileMoneyBinding). If either changes, the amounts are
 *     cleared and the merchant is told — an amount is never silently re-read
 *     in a different currency.
 *
 * Everything here is presentation logic: the server still authorizes the
 * create and decides which organization it lands in.
 */
import type { Currency } from "@/types";

export const BUSINESS_CURRENCIES: readonly Currency[] = ["USD", "KHR"];

export function isBusinessCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (BUSINESS_CURRENCIES as readonly string[]).includes(value);
}

/**
 * Lives under the "settings" root so the settings partition purges it on any
 * principal change, and carries the principal so organization A's answer can
 * never be read back under organization B.
 */
export function businessCurrencyQueryKey(userId: string, organizationId: string) {
  return ["settings", userId, organizationId, "business-currency"] as const;
}

export interface BusinessCurrencyResponse {
  organizationId: string;
  currency: unknown;
}

/** Thrown when a response belongs to a different organization than was asked. */
export class StaleBusinessCurrencyError extends Error {
  constructor() {
    super("Business currency response is for a different organization");
    this.name = "StaleBusinessCurrencyError";
  }
}

/**
 * The currency in `response`, only when it was answered for
 * `expectedOrganizationId` and is a supported code. Anything else throws.
 */
export function verifyBusinessCurrency(
  response: BusinessCurrencyResponse,
  expectedOrganizationId: string,
): { organizationId: string; currency: Currency } {
  if (!response || response.organizationId !== expectedOrganizationId) {
    throw new StaleBusinessCurrencyError();
  }
  if (!isBusinessCurrency(response.currency)) {
    throw new Error("Unsupported business currency");
  }
  return { organizationId: response.organizationId, currency: response.currency };
}

export type BusinessCurrencyState =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "error" }
  | { status: "ready"; organizationId: string; currency: Currency };

export interface BusinessCurrencyInputs {
  /** The /app guard's server-derived principal, or null when unresolved. */
  principal: { userId: string; organizationId: string } | null;
  /** products.create from the current capability snapshot (presentation only). */
  canCreate: boolean;
  query: {
    isError: boolean;
    error: unknown;
    data: { organizationId: string; currency: Currency } | undefined;
  };
}

const DENIED_MESSAGES = new Set([
  "Not authenticated",
  "No active organization membership",
  "Owner access required",
]);

function isDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Missing permission:") || DENIED_MESSAGES.has(message);
}

export function resolveBusinessCurrencyState({
  principal,
  canCreate,
  query,
}: BusinessCurrencyInputs): BusinessCurrencyState {
  if (!canCreate) return { status: "denied" };
  if (!principal) return { status: "loading" };
  if (query.isError) return isDeniedError(query.error) ? { status: "denied" } : { status: "error" };
  // Defence in depth: data cached under this key is re-checked against the
  // principal the form is rendering for.
  if (query.data && query.data.organizationId === principal.organizationId) {
    return {
      status: "ready",
      organizationId: query.data.organizationId,
      currency: query.data.currency,
    };
  }
  if (query.data) return { status: "error" };
  return { status: "loading" };
}

/** What entered amounts were typed under. */
export interface MoneyBinding {
  organizationId: string;
  currency: Currency;
}

export interface MoneyBindingResult {
  binding: MoneyBinding | null;
  /** True when entered amounts must be cleared because their meaning changed. */
  clearAmounts: boolean;
}

/**
 * Binds the form to the first known business currency, and re-binds — with
 * the entered amounts cleared — when the organization or currency changes.
 * A state that is not ready leaves the binding alone (the form is blocked
 * meanwhile), so a transient refetch never wipes what the merchant typed.
 */
export function reconcileMoneyBinding(
  binding: MoneyBinding | null,
  state: BusinessCurrencyState,
  hasAmounts: boolean,
): MoneyBindingResult {
  if (state.status !== "ready") return { binding, clearAmounts: false };
  const next = { organizationId: state.organizationId, currency: state.currency };
  if (binding === null) return { binding: next, clearAmounts: false };
  if (binding.organizationId === next.organizationId && binding.currency === next.currency) {
    return { binding, clearAmounts: false };
  }
  return { binding: next, clearAmounts: hasAmounts };
}

/**
 * What a product create was initiated under: the principal the form rendered
 * for and the business currency it confirmed. Sent with the create as a
 * CONSISTENCY CHECK only — the server still derives user and organization
 * from the session and refuses the write when they differ from this.
 */
export interface ProductCreateBinding {
  userId: string;
  organizationId: string;
  currency: Currency;
}

/** The server's refusal when a create no longer matches its binding. */
export const CREATE_BINDING_CHANGED_MESSAGE =
  "Business or currency changed before saving; review the product and try again";

export function isCreateBindingChanged(error: unknown): boolean {
  return error instanceof Error && error.message === CREATE_BINDING_CHANGED_MESSAGE;
}

/** The form may accept and submit amounts only while state and binding agree. */
export function moneyBindingIsLive(
  binding: MoneyBinding | null,
  state: BusinessCurrencyState,
): binding is MoneyBinding {
  return (
    binding !== null &&
    state.status === "ready" &&
    binding.organizationId === state.organizationId &&
    binding.currency === state.currency
  );
}
