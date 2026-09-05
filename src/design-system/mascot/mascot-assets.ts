import apsiDefault from "@/assets/mascot/apsi-default.png.asset.json";
import apsiWaving from "@/assets/mascot/apsi-waving.png.asset.json";
import apsiWinking from "@/assets/mascot/apsi-winking.png.asset.json";
import apsiTyping from "@/assets/mascot/apsi-typing.png.asset.json";
import apsiMerging from "@/assets/mascot/apsi-merging.png.asset.json";
import companionNilo from "@/assets/mascot/companion-nilo.png.asset.json";
import companionMinto from "@/assets/mascot/companion-minto.png.asset.json";
import companionVela from "@/assets/mascot/companion-vela.png.asset.json";
import companionSuri from "@/assets/mascot/companion-suri.png.asset.json";
import companionLuma from "@/assets/mascot/companion-luma.png.asset.json";

/**
 * The five canonical Apsi poses from the APSA Character IP & Brand Guide.
 * Artwork is authored outside the app; the app only ever references a pose.
 */
export type ApsiPose = "default" | "waving" | "winking" | "typing" | "merging";

/** The five mini companions and their brand meaning. */
export type CompanionName = "nilo" | "minto" | "vela" | "suri" | "luma";

/**
 * How a mascot frame is delivered today. Every renderer target is listed so a
 * state can be upgraded from static art to Lottie/Rive/video/3D by swapping the
 * source object only — no component or screen changes.
 */
export type MascotMediaKind = "image" | "lottie" | "rive" | "video";

export interface MascotSource {
  kind: MascotMediaKind;
  /** Stable asset name, e.g. `apsi-payment-success`. */
  name: string;
  url: string;
  /** True while the frame is stand-in art taken from the brand guide sheet. */
  placeholder: boolean;
}

const POSE_URL: Record<ApsiPose, string> = {
  default: apsiDefault.url,
  waving: apsiWaving.url,
  winking: apsiWinking.url,
  typing: apsiTyping.url,
  merging: apsiMerging.url,
};

export const COMPANION_URL: Record<CompanionName, string> = {
  nilo: companionNilo.url,
  minto: companionMinto.url,
  vela: companionVela.url,
  suri: companionSuri.url,
  luma: companionLuma.url,
};

export const COMPANION_TOKEN: Record<CompanionName, string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

export const COMPANION_MEANING: Record<CompanionName, string> = {
  nilo: "Help / connected",
  minto: "Success / payment",
  vela: "AI / automation",
  suri: "Tip / opportunity",
  luma: "Customer love / engagement",
};

/**
 * Resolves the media for a named mascot asset. Today every name falls back to
 * its brand-guide pose still. When real animation lands, register the file here
 * (kind: "lottie" | "rive" | "video", placeholder: false) and nothing else moves.
 */
export function resolveMascotSource(name: string, pose: ApsiPose): MascotSource {
  return { kind: "image", name, url: POSE_URL[pose], placeholder: true };
}

export function companionSource(companion: CompanionName): MascotSource {
  return {
    kind: "image",
    name: `companion-${companion}`,
    url: COMPANION_URL[companion],
    placeholder: true,
  };
}
