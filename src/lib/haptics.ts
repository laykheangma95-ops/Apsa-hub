/**
 * Light haptic feedback for navigation-scale gestures.
 *
 * The Vibration API is the only haptic a web app gets, and plenty of devices
 * (every iOS browser today) simply do not have it. That is fine: haptics are a
 * confirmation of something the merchant can already see, never the signal
 * itself, so a silent no-op costs nothing.
 *
 * Respects prefers-reduced-motion — a merchant who asked for less movement did
 * not ask for a phone that buzzes instead.
 */

type HapticStrength = "light" | "medium";

const PATTERN: Record<HapticStrength, number> = {
  light: 8,
  medium: 16,
};

export function haptic(strength: HapticStrength = "light"): void {
  if (typeof window === "undefined") return;
  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    navigator.vibrate?.(PATTERN[strength]);
  } catch {
    // A browser that refuses to vibrate is not an error worth surfacing.
  }
}
