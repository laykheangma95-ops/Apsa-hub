/**
 * Structural tests for the premium motion & interaction polish pass.
 *
 * These assert the contract, not the pixels: the entry-motion utilities exist
 * and stay transform/opacity-only, the reduced-motion block collapses them
 * (including stagger delays, which `animation-duration` alone does not), the
 * sheet keeps its spring + keyboard-safe focus scroll, and the shared Button
 * keeps its tactile press. Same file-reading style as
 * src/tests/mobile-nav-structure.test.js.
 *
 * Run: bun test src/tests/motion-polish.test.ts
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const styles = read("src/styles.css");
const bottomSheet = read("src/design-system/BottomSheet.tsx");
const button = read("src/components/ui/button.tsx");
const spinner = read("src/design-system/Spinner.tsx");
const dsIndex = read("src/design-system/index.ts");
const rootRoute = read("src/routes/__root.tsx");

describe("entry-motion primitives", () => {
  it("defines one shared rise-in keyframe, transform/opacity only", () => {
    expect(styles).toContain("@keyframes rise-in");
    const keyframe = styles.slice(styles.indexOf("@keyframes rise-in"));
    const block = keyframe.slice(0, keyframe.indexOf("}") + 1);
    expect(block).not.toMatch(/height|width|margin|padding|top|left/);
  });

  it("exposes animate-rise, content-in and list-enter utilities", () => {
    expect(styles).toContain("@utility animate-rise");
    expect(styles).toContain("@utility content-in");
    expect(styles).toContain(".list-enter > *");
  });

  it("caps the list stagger so long lists never wait", () => {
    expect(styles).toContain(".list-enter > *:nth-child(n+8)");
  });
});

describe("reduced-motion support", () => {
  it("keeps the global duration collapse", () => {
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("animation-duration: 0.01ms !important");
  });

  it("also zeroes stagger delays — `both` fill would otherwise hold items invisible", () => {
    const reduceBlock = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduceBlock).toContain("animation-delay: 0ms !important");
    expect(reduceBlock).toContain(".list-enter > *");
  });
});

describe("bottom sheet", () => {
  it("opens and closes with a spring, not a tween", () => {
    expect(bottomSheet).toContain('type: "spring"');
  });

  it("stays instant under reduced motion", () => {
    expect(bottomSheet).toContain("useReducedMotion");
    expect(bottomSheet).toMatch(/reduceMotion\s*\?\s*\{ duration: 0 \}/);
  });

  it("scrolls focused fields into view inside the sheet (keyboard-safe)", () => {
    expect(bottomSheet).toContain('document.addEventListener("focusin", onFocusIn)');
    expect(bottomSheet).toContain("scrollIntoView");
  });

  it("keeps focus trap, escape and restore behaviour", () => {
    expect(bottomSheet).toContain('event.key === "Escape"');
    expect(bottomSheet).toContain('event.key !== "Tab"');
    expect(bottomSheet).toContain("restoreRef.current?.focus?.()");
  });
});

describe("shared button", () => {
  it("carries tactile press feedback on the shared base", () => {
    expect(button).toContain("active:scale-[0.98]");
    expect(button).toContain("[-webkit-tap-highlight-color:transparent]");
  });

  it("keeps honest disabled styling", () => {
    expect(button).toContain("disabled:opacity-50");
    expect(button).toContain("disabled:pointer-events-none");
  });
});

describe("spinner", () => {
  it("is decorative-only (words and aria-busy carry the state)", () => {
    expect(spinner).toContain("aria-hidden");
  });

  it("is exported from the design system", () => {
    expect(dsIndex).toContain('export { Spinner } from "./Spinner";');
  });
});

describe("viewport", () => {
  it("asks supporting browsers to resize the layout for the keyboard", () => {
    expect(rootRoute).toContain("interactive-widget=resizes-content");
  });

  it("keeps cover-fit for iPhone safe areas", () => {
    expect(rootRoute).toContain("viewport-fit=cover");
  });
});
