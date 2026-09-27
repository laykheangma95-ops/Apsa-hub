/**
 * Server-side cooldown for public auth emails (password reset, verification
 * resend). Imported only by src/api/auth.ts handlers.
 *
 * Scope — deliberately minimal:
 *   - In-memory, per server instance. It stops a direct caller hammering one
 *     instance for the same address; it is NOT a distributed limiter. Supabase
 *     Auth's own email rate limits remain the hard, provider-side limit.
 *   - Keyed by a SHA-256 digest of (purpose, normalised email) — raw addresses
 *     are never held in memory or logged.
 *   - A throttled request is answered exactly like a sent one, so the
 *     throttle itself cannot be used to learn whether an account exists.
 *   - Bounded: expired entries are pruned and the oldest evicted past
 *     MAX_ENTRIES, so memory cannot grow without limit.
 */
import { AUTH_EMAIL_COOLDOWN_SECONDS } from "@/lib/auth-recovery";

export type AuthEmailPurpose = "password_reset" | "verification_resend";

const MAX_ENTRIES = 5000;
const lastSentAt = new Map<string, number>();

async function throttleKey(purpose: AuthEmailPurpose, email: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${purpose}:${email.trim().toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function prune(now: number, windowMs: number): void {
  for (const [key, at] of lastSentAt) {
    if (now - at >= windowMs) lastSentAt.delete(key);
  }
  while (lastSentAt.size >= MAX_ENTRIES) {
    const oldest = lastSentAt.keys().next().value;
    if (oldest === undefined) break;
    lastSentAt.delete(oldest);
  }
}

/**
 * Returns true — and records the attempt — when an email may be sent now;
 * false while the address is still inside its cooldown window.
 */
export async function claimAuthEmailSlot(
  purpose: AuthEmailPurpose,
  email: string,
  now: number = Date.now(),
): Promise<boolean> {
  const windowMs = AUTH_EMAIL_COOLDOWN_SECONDS * 1000;
  const key = await throttleKey(purpose, email);
  const previous = lastSentAt.get(key);
  if (previous !== undefined && now - previous < windowMs) return false;

  lastSentAt.delete(key);
  prune(now, windowMs);
  lastSentAt.set(key, now);
  return true;
}

/** Test hook — clears every recorded attempt. */
export function resetAuthEmailThrottle(): void {
  lastSentAt.clear();
}
