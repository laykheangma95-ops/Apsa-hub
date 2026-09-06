import { apsiEmotions, type ApsiEmotion, type ApsiEmotionSpec } from "./apsi-emotions";

export type LegacyMascotState =
  | "greeting"
  | "celebration"
  | "warning"
  | "empty"
  | "payment-success"
  | "delivery-success"
  | "order-success"
  | "customer-loyalty"
  | "analytics-insight"
  | "achievement";

export type MascotState = ApsiEmotion | LegacyMascotState;
export type MascotSurface = ApsiEmotionSpec["surface"];
export type MascotStateSpec = ApsiEmotionSpec;

const LEGACY_STATE_EMOTION: Record<LegacyMascotState, ApsiEmotion> = {
  greeting: "waving",
  celebration: "excited",
  warning: "confused",
  empty: "sleepy",
  "payment-success": "approved",
  "delivery-success": "success",
  "order-success": "success",
  "customer-loyalty": "grateful",
  "analytics-insight": "thinking",
  achievement: "excited",
};

export function resolveMascotEmotion(state: MascotState): ApsiEmotion {
  return state in LEGACY_STATE_EMOTION
    ? LEGACY_STATE_EMOTION[state as LegacyMascotState]
    : (state as ApsiEmotion);
}

export function getMascotStateSpec(state: MascotState): MascotStateSpec {
  return apsiEmotions[resolveMascotEmotion(state)];
}

/** Compatibility registry for existing state-based call sites. */
export const MASCOT_STATES = Object.fromEntries(
  ([...Object.keys(apsiEmotions), ...Object.keys(LEGACY_STATE_EMOTION)] as MascotState[]).map(
    (state) => [state, getMascotStateSpec(state)],
  ),
) as Record<MascotState, MascotStateSpec>;

export const MASCOT_STATE_KEYS = Object.keys(MASCOT_STATES) as MascotState[];

export function isMascotAllowed(surface: MascotSurface | "operational"): boolean {
  return surface !== "operational";
}