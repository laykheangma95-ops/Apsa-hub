import type { ApsiPose, CompanionName } from "./mascot-assets";

/**
 * The official APSA mascot state vocabulary.
 *
 * Screens never pick a pose or an image — they name a *moment*. That keeps one
 * consistent character language across onboarding, AI, success and empty states,
 * and lets art be replaced centrally.
 */
export type MascotState =
  | "default"
  | "greeting"
  | "thinking"
  | "typing"
  | "success"
  | "celebration"
  | "warning"
  | "empty"
  | "payment-success"
  | "delivery-success"
  | "order-success"
  | "customer-loyalty"
  | "analytics-insight"
  | "achievement";

/** Where a state is allowed to appear. Dense operational UI stays mascot-free. */
export type MascotSurface = "marketing" | "onboarding" | "moment" | "empty" | "insight";

export interface MascotStateSpec {
  /** Asset naming convention: apsi-default, apsi-payment-success, ... */
  asset: string;
  /** Brand-guide pose the artwork is based on. */
  pose: ApsiPose;
  /** Accent companion that appears with Apsi in this moment, if any. */
  companion?: CompanionName;
  /** Emotional intent, for writers and future animators. */
  intent: string;
  surface: MascotSurface;
  /** Motion brief for the future Rive/Lottie asset. */
  motion: string;
  /** Loop by default (idle/processing) vs play once (moments). */
  loop: boolean;
}

export const MASCOT_STATES: Record<MascotState, MascotStateSpec> = {
  default: {
    asset: "apsi-default",
    pose: "default",
    intent: "Calm presence, nothing needed from the merchant",
    surface: "marketing",
    motion: "Soft idle breathing, slow glow pulse",
    loop: true,
  },
  greeting: {
    asset: "apsi-greeting",
    pose: "waving",
    companion: "nilo",
    intent: "Welcome, onboarding, first run",
    surface: "onboarding",
    motion: "Wave once, settle into idle",
    loop: false,
  },
  thinking: {
    asset: "apsi-thinking",
    pose: "winking",
    companion: "vela",
    intent: "AI is processing or summarising",
    surface: "insight",
    motion: "Orbiting glass particles, gentle head tilt, loops until done",
    loop: true,
  },
  typing: {
    asset: "apsi-typing",
    pose: "typing",
    companion: "vela",
    intent: "Assistant drafting a reply in chat",
    surface: "insight",
    motion: "Typing bounce with three-dot bubble",
    loop: true,
  },
  success: {
    asset: "apsi-success",
    pose: "winking",
    companion: "minto",
    intent: "Generic action completed",
    surface: "moment",
    motion: "Spring pop, mint flash, ease out",
    loop: false,
  },
  celebration: {
    asset: "apsi-celebration",
    pose: "merging",
    companion: "luma",
    intent: "Big shared win, milestone reached",
    surface: "moment",
    motion: "Jump with sparkle burst, confetti-lite",
    loop: false,
  },
  warning: {
    asset: "apsi-warning",
    pose: "default",
    companion: "suri",
    intent: "Something needs attention — concerned, never alarming",
    surface: "insight",
    motion: "Small attention nudge, single shake",
    loop: false,
  },
  empty: {
    asset: "apsi-empty",
    pose: "waving",
    intent: "Nothing here yet, invite the first action",
    surface: "empty",
    motion: "Idle float with a slow blink",
    loop: true,
  },
  "payment-success": {
    asset: "apsi-payment-success",
    pose: "winking",
    companion: "minto",
    intent: "Payment received and confirmed",
    surface: "moment",
    motion: "Mint check-mark seal, spring settle",
    loop: false,
  },
  "delivery-success": {
    asset: "apsi-delivery-success",
    pose: "merging",
    companion: "minto",
    intent: "Parcel delivered to the customer",
    surface: "moment",
    motion: "Hand-off gesture, parcel lands, glow",
    loop: false,
  },
  "order-success": {
    asset: "apsi-order-success",
    pose: "winking",
    companion: "nilo",
    intent: "Order created from a conversation or POS",
    surface: "moment",
    motion: "Message merges into an order card",
    loop: false,
  },
  "customer-loyalty": {
    asset: "apsi-customer-loyalty",
    pose: "merging",
    companion: "luma",
    intent: "Returning customer, relationship moment",
    surface: "insight",
    motion: "Heart orbit, warm pulse",
    loop: true,
  },
  "analytics-insight": {
    asset: "apsi-analytics-insight",
    pose: "typing",
    companion: "suri",
    intent: "Apsi found something worth acting on",
    surface: "insight",
    motion: "Chart bars rise, Suri pops with a tip",
    loop: false,
  },
  achievement: {
    asset: "apsi-achievement",
    pose: "merging",
    companion: "suri",
    intent: "Badge or goal unlocked",
    surface: "moment",
    motion: "Badge stamp with gold shimmer sweep",
    loop: false,
  },
};

export const MASCOT_STATE_KEYS = Object.keys(MASCOT_STATES) as MascotState[];

/**
 * Dense operational surfaces (Inbox list, Conversation, POS, Orders, Products)
 * must stay mascot-free per the brand rules. Use this in reviews/tests.
 */
export function isMascotAllowed(surface: MascotSurface | "operational"): boolean {
  return surface !== "operational";
}
