import { format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import type { Language } from "@/types";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (/[\u1780-\u17FF]/.test(name)) return name.slice(0, 1);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (isToday(date)) return format(date, "h:mm a");
  if (isYesterday(date)) return format(date, "h:mm a");
  return format(date, "d MMM");
}

export function relativeTime(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
}

export function fullTimestamp(iso: string): string {
  return format(new Date(iso), "d MMM yyyy, h:mm a");
}

export function localName<T extends { nameKm: string; nameEn: string }>(
  entity: T,
  lang: Language,
): string {
  return lang === "km" ? entity.nameKm : entity.nameEn;
}

/**
 * Today's date, in the merchant's own locale.
 *
 * Rendered from the browser's clock, so it must only ever be shown after
 * mount: the server's timezone is not the merchant's, and a date string
 * rendered during SSR is a hydration mismatch waiting for a midnight in
 * Phnom Penh to find it.
 */
export function todayLabel(lang: Language): string {
  return new Date().toLocaleDateString(lang === "km" ? "km-KH" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function percent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}
