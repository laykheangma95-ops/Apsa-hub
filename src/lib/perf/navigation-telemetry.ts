/**
 * Navigation telemetry wire format — staging/development diagnostics ONLY.
 *
 * The one schema a browser `perf.navigation` record (navigation-timing.ts) may
 * take on its way to the server, and the one schema the server accepts. It is
 * an ALLOWLIST: every key is named, `.strict()` rejects any other key, screen
 * labels must be one of KNOWN_SCREENS, and every number is bounded. Nothing
 * that could carry an identifier (a raw path, a route param, a search param, a
 * user/org/record ID, free text) has a field to travel in.
 *
 * Shared by the browser and the server; imports nothing but zod.
 */
import { z } from "zod";

/** /app sections, as screenOf() labels them (src/routes/app.*.tsx). */
const APP_SECTIONS = [
  "analytics",
  "customers",
  "deliveries",
  "handoff",
  "inbox",
  "inventory",
  "orders",
  "pack",
  "parcels",
  "pick",
  "payments",
  "pos",
  "products",
  "returns",
  "settings",
  "team",
] as const;

/** First path segment of the public routes, as screenOf() labels them. */
const PUBLIC_SCREENS = [
  "public.root",
  "public.access-denied",
  "public.design",
  "public.design-mascot",
  "public.design-status-badge",
  "public.forgot-password",
  "public.invite",
  "public.onboarding",
  "public.reset-password",
  "public.sign-in",
  "public.sign-up",
  "public.verify-email",
] as const;

/** Any screen label not in this list travels as "other". */
export const KNOWN_SCREENS: readonly string[] = [
  "home",
  ...APP_SECTIONS,
  ...APP_SECTIONS.map((section) => `${section}.detail`),
  ...PUBLIC_SCREENS,
  "other",
];

export const TIMING_FIELDS = [
  "navigateMs",
  "pendingMs",
  "loadedMs",
  "renderedMs",
  "contentMs",
] as const;

/** Timings above this are clamped: a background tab, not a navigation. */
export const MAX_TIMING_MS = 60_000;
/** Serialized payload ceiling; a full valid record is ~250 characters. */
export const MAX_PAYLOAD_CHARS = 512;
export const TELEMETRY_LOCALES = ["en", "km"] as const;

const screen = z.string().refine((value) => KNOWN_SCREENS.includes(value));
const timing = z
  .number()
  .finite()
  .nonnegative()
  .transform((ms) => Math.round(Math.min(ms, MAX_TIMING_MS)));

export const navigationTelemetrySchema = z
  .object({
    from: screen,
    to: screen,
    tracked: z.boolean(),
    navigateMs: timing.optional(),
    pendingMs: timing.optional(),
    loadedMs: timing.optional(),
    renderedMs: timing.optional(),
    contentMs: timing.optional(),
    /** CSS pixel width, bucketed to 10px. */
    viewport: z.number().int().min(1).max(10_000).optional(),
    locale: z.enum(TELEMETRY_LOCALES).optional(),
    /** Epoch milliseconds on the client clock. */
    clientTs: z.number().int().nonnegative().max(10_000_000_000_000).optional(),
  })
  .strict();

export type NavigationTelemetry = z.output<typeof navigationTelemetrySchema>;

export interface TelemetryRecordLike {
  from: string;
  to: string;
  tracked: boolean;
  navigateMs?: number;
  pendingMs?: number;
  loadedMs?: number;
  renderedMs?: number;
  contentMs?: number;
}

export interface TelemetryMeta {
  viewport?: number;
  locale?: string;
  clientTs?: number;
}

const coarseScreen = (label: string) => (KNOWN_SCREENS.includes(label) ? label : "other");

/**
 * Browser side: copy ONLY the allowlisted fields of a timing record into a
 * wire payload. Returns null when the result would not pass the schema, in
 * which case nothing is sent.
 */
export function toTelemetryPayload(
  record: TelemetryRecordLike,
  meta: TelemetryMeta = {},
): NavigationTelemetry | null {
  const candidate: Record<string, unknown> = {
    from: coarseScreen(record.from),
    to: coarseScreen(record.to),
    tracked: record.tracked === true,
  };
  for (const field of TIMING_FIELDS) {
    const ms = record[field];
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) candidate[field] = ms;
  }
  if (typeof meta.viewport === "number" && Number.isFinite(meta.viewport)) {
    candidate["viewport"] = Math.max(1, Math.min(10_000, Math.round(meta.viewport / 10) * 10));
  }
  const locale = meta.locale?.toLowerCase().slice(0, 2);
  if (locale === "en" || locale === "km") candidate["locale"] = locale;
  if (typeof meta.clientTs === "number" && Number.isFinite(meta.clientTs)) {
    candidate["clientTs"] = Math.round(meta.clientTs);
  }
  const parsed = navigationTelemetrySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Server side: the untrusted request body → a validated record, or null. Never
 * throws and never echoes the input.
 */
export function parseNavigationTelemetry(input: unknown): NavigationTelemetry | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  let size: number;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return null;
  }
  if (size > MAX_PAYLOAD_CHARS) return null;
  const parsed = navigationTelemetrySchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
