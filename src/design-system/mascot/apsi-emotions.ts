import {
  resolveMascotSource,
  type ApsiPose,
  type CompanionName,
  type MascotSource,
} from "./mascot-assets";

export type ApsiEmotion =
  | "default"
  | "waving"
  | "winking"
  | "grateful"
  | "thinking"
  | "typing"
  | "laughing"
  | "excited"
  | "success"
  | "surprised"
  | "confused"
  | "listening"
  | "sleepy"
  | "supportive"
  | "approved"
  | "merge";

export type ApsiAnimation =
  "none" | "float" | "gentle-bounce" | "wave" | "blink" | "pulse" | "celebrate" | "thinking";

export type ApsiSurface = "marketing" | "onboarding" | "moment" | "empty" | "insight";

export interface ApsiEmotionSpec {
  label: string;
  asset: string;
  pose: ApsiPose;
  source: MascotSource;
  animation: ApsiAnimation;
  companion?: CompanionName;
  intent: string;
  placement: string;
  surface: ApsiSurface;
  loop: boolean;
}

function emotion(
  name: ApsiEmotion,
  pose: ApsiPose,
  config: Omit<ApsiEmotionSpec, "asset" | "pose" | "source">,
): ApsiEmotionSpec {
  const asset = `apsi-${name}`;
  return { ...config, asset, pose, source: resolveMascotSource(asset, pose) };
}

/**
 * Single source of truth for Apsi's emotional language and media.
 * Replace `source` for any entry when final WebP, Lottie, Rive, video, or 3D
 * artwork arrives; callers continue to use only the semantic emotion name.
 */
export const apsiEmotions: Record<ApsiEmotion, ApsiEmotionSpec> = {
  default: emotion("default", "default", {
    label: "Default",
    animation: "float",
    intent: "Calm, friendly assistant presence",
    placement: "Normal assistant state",
    surface: "marketing",
    loop: true,
  }),
  waving: emotion("waving", "waving", {
    label: "Waving / hello",
    animation: "wave",
    companion: "nilo",
    intent: "A warm welcome without feeling playful",
    placement: "Onboarding and welcome moments",
    surface: "onboarding",
    loop: false,
  }),
  winking: emotion("winking", "winking", {
    label: "Winking assistant",
    animation: "blink",
    companion: "vela",
    intent: "Helpful assistant acknowledgement",
    placement: "Assistant tips and lightweight guidance",
    surface: "insight",
    loop: false,
  }),
  grateful: emotion("grateful", "merging", {
    label: "Heart eyes / grateful",
    animation: "pulse",
    companion: "luma",
    intent: "Customer appreciation and gratitude",
    placement: "Customer appreciation moments",
    surface: "moment",
    loop: false,
  }),
  thinking: emotion("thinking", "winking", {
    label: "Thinking",
    animation: "thinking",
    companion: "vela",
    intent: "Careful processing or summarising",
    placement: "AI processing and insights",
    surface: "insight",
    loop: true,
  }),
  typing: emotion("typing", "typing", {
    label: "Typing / chat",
    animation: "gentle-bounce",
    companion: "vela",
    intent: "Drafting or preparing a response",
    placement: "Chat drafting states, outside the active thread",
    surface: "insight",
    loop: true,
  }),
  laughing: emotion("laughing", "merging", {
    label: "Happy / laughing",
    animation: "gentle-bounce",
    companion: "luma",
    intent: "Warm delight and shared joy",
    placement: "Positive milestones",
    surface: "moment",
    loop: false,
  }),
  excited: emotion("excited", "merging", {
    label: "Excited / jump",
    animation: "celebrate",
    companion: "suri",
    intent: "A meaningful milestone has been reached",
    placement: "Achievements and major wins",
    surface: "moment",
    loop: false,
  }),
  success: emotion("success", "winking", {
    label: "Celebrate / success",
    animation: "celebrate",
    companion: "minto",
    intent: "An action completed successfully",
    placement: "Success confirmations",
    surface: "moment",
    loop: false,
  }),
  surprised: emotion("surprised", "default", {
    label: "Surprise / wow",
    animation: "gentle-bounce",
    companion: "suri",
    intent: "A noteworthy result or discovery",
    placement: "Exceptional insights",
    surface: "insight",
    loop: false,
  }),
  confused: emotion("confused", "default", {
    label: "Confused / question",
    animation: "thinking",
    companion: "suri",
    intent: "More information or help is needed",
    placement: "Unclear, help, and recoverable error states",
    surface: "insight",
    loop: true,
  }),
  listening: emotion("listening", "default", {
    label: "Calm / listening",
    animation: "pulse",
    companion: "nilo",
    intent: "Quiet attention to voice or input",
    placement: "Listening and voice states",
    surface: "insight",
    loop: true,
  }),
  sleepy: emotion("sleepy", "default", {
    label: "Sleepy / rest",
    animation: "float",
    intent: "A calm pause when nothing needs attention",
    placement: "Gentle empty and rest states",
    surface: "empty",
    loop: true,
  }),
  supportive: emotion("supportive", "default", {
    label: "Sad / supportive",
    animation: "pulse",
    companion: "nilo",
    intent: "Reassuring support after a setback",
    placement: "Friendly error and recovery states",
    surface: "empty",
    loop: true,
  }),
  approved: emotion("approved", "winking", {
    label: "Thumbs up / approved",
    animation: "gentle-bounce",
    companion: "minto",
    intent: "Payment or order approval",
    placement: "Approved payment and order moments",
    surface: "moment",
    loop: false,
  }),
  merge: emotion("merge", "merging", {
    label: "Merge / connection",
    animation: "pulse",
    companion: "nilo",
    intent: "Channels and customer context coming together",
    placement: "Unified social-channel storytelling",
    surface: "marketing",
    loop: true,
  }),
};

export const APSI_EMOTION_KEYS = Object.keys(apsiEmotions) as ApsiEmotion[];
