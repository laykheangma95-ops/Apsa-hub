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
