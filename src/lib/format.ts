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

export function percent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}
