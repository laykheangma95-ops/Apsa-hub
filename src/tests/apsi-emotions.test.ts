import { describe, expect, test } from "bun:test";
import {
  APSI_EMOTION_KEYS,
  apsiEmotions,
  type ApsiEmotion,
} from "@/design-system/mascot/apsi-emotions";
import { isMascotAllowed, resolveMascotEmotion } from "@/design-system/mascot/mascot-states";

const EXPECTED: ApsiEmotion[] = [
  "default",
  "waving",
  "winking",
  "grateful",
  "thinking",
  "typing",
  "laughing",
  "excited",
  "success",
  "surprised",
  "confused",
  "listening",
  "sleepy",
  "supportive",
  "approved",
  "merge",
];

describe("Apsi emotion registry", () => {
  test("contains the complete canonical emotion vocabulary", () => {
    expect(APSI_EMOTION_KEYS).toEqual(EXPECTED);
  });

  test("keeps every asset and motion decision centralized", () => {
    for (const emotion of EXPECTED) {
      const spec = apsiEmotions[emotion];
      expect(spec.asset).toBe(`apsi-${emotion}`);
      expect(spec.source.url).toStartWith("/__l5e/assets-v1/");
      expect(spec.source.kind).toBe("image");
      expect(spec.animation.length).toBeGreaterThan(0);
    }
  });

  test("preserves legacy state aliases", () => {
    expect(resolveMascotEmotion("greeting")).toBe("waving");
    expect(resolveMascotEmotion("payment-success")).toBe("approved");
    expect(resolveMascotEmotion("achievement")).toBe("excited");
  });

  test("forbids mascot placement on operational surfaces", () => {
    expect(isMascotAllowed("operational")).toBe(false);
    expect(isMascotAllowed("onboarding")).toBe(true);
  });
});