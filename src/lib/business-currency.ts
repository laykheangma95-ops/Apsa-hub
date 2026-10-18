/**
 * The organization's selling currency (organizations.default_currency) — the
 * one currency every order is written in.
 *
 * The order RPC snapshots default_currency onto each order and refuses any
 * line whose variant is priced in another currency (`currency_mismatch`), so
 * a product priced in the wrong currency is a product that cannot be sold.
 * These helpers let the catalog UI start from the business currency and say
 * so when a price moves away from it. They are presentation only: the server
 * remains the authority on what may be ordered.
 */
import type { Currency } from "@/types";

export const BUSINESS_CURRENCIES: readonly Currency[] = ["USD", "KHR"];

export function isBusinessCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (BUSINESS_CURRENCIES as readonly string[]).includes(value);
}

/**
 * The currency a new price should start in: the business currency when it is
 * known, otherwise USD (the schema default, and what the sheet used before).
 */
export function initialPriceCurrency(businessCurrency: Currency | null): Currency {
  return businessCurrency ?? "USD";
}

/**
 * True only when the business currency is KNOWN and the chosen price currency
 * differs from it. An unknown business currency never raises a warning.
 */
export function priceCurrencyMismatch(
  priceCurrency: Currency,
  businessCurrency: Currency | null,
): boolean {
  return businessCurrency !== null && priceCurrency !== businessCurrency;
}
