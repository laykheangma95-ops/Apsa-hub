import type { Money, Currency } from "@/types";

/** One constant. Never repeated as a literal anywhere else. */
export const KHR_PER_USD = 4100;

/** Cambodia has no coins — riel always rounds to the nearest 100. */
export const KHR_ROUNDING = 100;

const MINOR_UNITS: Record<Currency, number> = { USD: 100, KHR: 1 };

export const usd = (cents: number): Money => ({ amount: Math.round(cents), currency: "USD" });
export const khr = (riel: number): Money => ({ amount: Math.round(riel), currency: "KHR" });

export function toMajor(m: Money): number {
  return m.amount / MINOR_UNITS[m.currency];
}

export function formatMoney(m: Money): string {
  if (m.currency === "USD") {
    const sign = m.amount < 0 ? "-" : "";
    const value = Math.abs(m.amount) / MINOR_UNITS.USD;
    return `${sign}$${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  const sign = m.amount < 0 ? "-" : "";
  return `${sign}៛${Math.abs(m.amount).toLocaleString("en-US")}`;
}

function roundKhr(riel: number): number {
  return Math.round(riel / KHR_ROUNDING) * KHR_ROUNDING;
}

export function usdToKhr(value: Money): Money {
  if (value.currency === "KHR") return value;
  return khr(roundKhr((value.amount / MINOR_UNITS.USD) * KHR_PER_USD));
}

export function khrToUsd(value: Money): Money {
  if (value.currency === "USD") return value;
  return usd(Math.round((value.amount / KHR_PER_USD) * MINOR_UNITS.USD));
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("Cannot add different currencies");
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("Cannot subtract different currencies");
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function multiplyMoney(m: Money, factor: number): Money {
  return { amount: Math.round(m.amount * factor), currency: m.currency };
}

/** Change is handed back in riel, rounded to the nearest 100. */
export function calculateChange(paid: Money, total: Money): Money {
  const paidKhr = usdToKhr(paid);
  const totalKhr = usdToKhr(total);
  return khr(roundKhr(paidKhr.amount - totalKhr.amount));
}

// ── Editable minor-unit amounts (typed input <-> integer minor units) ───────

/** Decimal places a currency's major unit shows. KHR has none — riel is the minor unit. */
export const MINOR_UNIT_DIGITS: Record<Currency, number> = { USD: 2, KHR: 0 };

/** Minor units in one major unit. The same table toMajor() divides by — never a second copy. */
function minorUnitFactor(currency: Currency): number {
  return MINOR_UNITS[currency];
}

/** Render minor units into an editable field. Integer division only. */
export function formatMinorUnitsForInput(amount: number, currency: Currency): string {
  const digits = MINOR_UNIT_DIGITS[currency];
  if (digits === 0) return String(amount);
  const factor = minorUnitFactor(currency);
  const whole = Math.trunc(amount / factor);
  const fraction = Math.abs(amount % factor);
  return `${whole}.${String(fraction).padStart(digits, "0")}`;
}

/**
 * Parse a typed amount into integer minor units, or null when it is not a
 * valid amount for this currency.
 *
 * Deliberately not `parseFloat(x) * 100`: 19.99 * 100 is 1998.9999999999998 in
 * IEEE-754, and rounding that away is exactly the floating-point money handling
 * ARCHITECTURE.md forbids. The whole and fractional parts are parsed as
 * separate integers and combined with integer arithmetic.
 */
export function parseMinorUnits(input: string, currency: Currency): number | null {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return null;

  const digits = MINOR_UNIT_DIGITS[currency];
  const match = digits === 0 ? /^(\d+)$/.exec(text) : /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return null;

  const whole = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(whole)) return null;
  if (digits === 0) return whole;

  const fractionText = (match[2] ?? "").padEnd(digits, "0");
  const fraction = fractionText === "" ? 0 : Number.parseInt(fractionText, 10);
  const total = whole * minorUnitFactor(currency) + fraction;
  return Number.isSafeInteger(total) ? total : null;
}
