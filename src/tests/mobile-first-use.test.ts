/**
 * First-use and mobile-shell contracts from the launch-readiness mobile audit.
 *
 * These are structural checks over the shipped source, in the style of
 * landing-cta-routes.test.js: they are cheap, they run in the default suite,
 * and each one pins a defect that was found by driving real Chromium at
 * 320/360/390/430 and would otherwise come back silently.
 *
 * What they do NOT do is claim to prove layout. The painted-geometry question
 * belongs to mobile-khmer-nav-fit.browser.ts, which measures it in a real
 * browser against the real built stylesheet.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import en from "../locales/en.json";
import km from "../locales/km.json";

const root = process.cwd();

/**
 * Source with its comments removed.
 *
 * These assertions are about what a screen DOES, and every screen here carries
 * a header comment describing the defect it fixes — including the very strings
 * being asserted against ("coming soon", "min-h-screen"). Matching raw source
 * would read those explanations as the code itself and report a fixed screen
 * as broken.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const read = (relative: string) =>
  stripComments(fs.readFileSync(path.join(root, relative), "utf8"));

const landing = read("src/routes/index.tsx");
const signIn = read("src/routes/sign-in.tsx");
const signUp = read("src/routes/sign-up.tsx");
const verifyEmail = read("src/routes/verify-email.tsx");
const accessDenied = read("src/routes/access-denied.tsx");
const styles = read("src/styles.css");
const bottomNav = read("src/design-system/BottomNav.tsx");

describe("a returning merchant can always reach sign in", () => {
  /*
   * The defect: /sign-in was linked from nowhere on the landing page. The only
   * header CTA was "Start free" (sign-up), and on a phone even that was hidden
   * behind the hamburger. A returning merchant on a phone had no route into
   * their own business short of typing the URL.
   */
  it("the landing page links to /sign-in", () => {
    expect(landing).toContain('to="/sign-in"');
  });

  it("the landing sign-in control is outside the collapsible mobile menu", () => {
    const menuStart = landing.indexOf("{mobileOpen && (");
    expect(menuStart).toBeGreaterThan(-1);

    // The sign-in link must appear in the always-visible header row, which is
    // everything before the conditional mobile menu block.
    const header = landing.slice(0, menuStart);
    expect(header).toContain('to="/sign-in"');
  });

  it("sign-in and sign-up each route to the other", () => {
    expect(signIn).toContain('to="/sign-up"');
    expect(signUp).toContain('to="/sign-in"');
  });
});

describe("the guard's own destinations are not dead ends", () => {
  /*
   * checkAppGuardFn redirects real members to /verify-email (unverified
   * address) and /access-denied (suspended or removed membership). Both were
   * untranslated one-liners with no way out: a merchant who landed on either
   * was stranded mid-journey with no explanation and no control to press.
   */
  it("/verify-email explains itself, verifies for real, and offers a route onward", () => {
    // PR #70 replaced the passive "waiting room" stub with the real
    // verification wiring; this pins that the real behaviour survives —
    // no local/fake verification, an honest route onward on every state.
    expect(verifyEmail).not.toContain("coming soon");
    expect(verifyEmail).toContain("verifyEmailFn");
    expect(verifyEmail).toContain("verifyEmail.title");
    expect(verifyEmail).toContain('to="/sign-up"');
    expect(verifyEmail).toContain('to: "/onboarding"');
  });

  it("/access-denied explains itself and offers a route back to sign in", () => {
    expect(accessDenied).toContain("auth.accessDenied.title");
    expect(accessDenied).toContain('to="/sign-in"');
  });
});

describe("the auth screens honour the APSA localization and mobile rules", () => {
  const screens = {
    "sign-in.tsx": signIn,
    "sign-up.tsx": signUp,
    "verify-email.tsx": verifyEmail,
    "access-denied.tsx": accessDenied,
  };

  it("every auth screen frames itself with dvh, never vh", () => {
    /*
     * On a phone `vh` is measured against the TALLEST possible viewport, so a
     * min-h-screen card was taller than the visible area and could push its
     * own submit button under the browser chrome.
     */
    for (const [name, source] of Object.entries(screens)) {
      expect({ name, usesScreenVh: source.includes("min-h-screen") }).toEqual({
        name,
        usesScreenVh: false,
      });
    }
  });

  it("every auth screen routes its visible copy through i18next", () => {
    // CLAUDE.md: no hard-coded user-facing strings; Khmer is the default.
    for (const [name, source] of Object.entries(screens)) {
      expect({ name, translated: source.includes("useTranslation") }).toEqual({
        name,
        translated: true,
      });
    }
  });

  it("the auth copy exists in both locales", () => {
    type AuthCopy = { auth: Record<string, Record<string, unknown>> };
    for (const locale of [en, km] as unknown as AuthCopy[]) {
      expect(Object.keys(locale.auth["signIn"]!)).toContain("submit");
      expect(Object.keys(locale.auth["signUp"]!)).toContain("submit");
      expect(Object.keys(locale.auth["verifyEmail"]!)).toContain("continueAction");
      expect(Object.keys(locale.auth["accessDenied"]!)).toContain("backToSignIn");
    }
  });

  it("the primary auth controls clear the 44px touch target", () => {
    // The shadcn defaults are h-9 (36px), under the target the rest of APSA
    // holds itself to. Each interactive control opts back up explicitly.
    for (const name of ["sign-in.tsx", "sign-up.tsx"] as const) {
      const source = screens[name];
      const inputs = source.match(/<Input\b/g) ?? [];
      const sized = source.match(/className="min-h-11"/g) ?? [];
      expect({ name, inputsSized: sized.length >= inputs.length }).toEqual({
        name,
        inputsSized: true,
      });
      expect(source).toContain('className="min-h-11 w-full"');
    }
  });

  it("a submitted auth form shows a pending state, not just a disabled colour", () => {
    for (const name of ["sign-in.tsx", "sign-up.tsx"] as const) {
      expect(screens[name]).toContain("aria-busy");
      expect(screens[name]).toContain("Spinner");
    }
  });
});

describe("screen clearance tracks the nav that is actually on screen", () => {
  /*
   * --nav-clearance was derived from a hand-written --nav-height: 64px, but
   * the mobile nav measures 87px at 360/390/430 and 96px at 320, where a
   * wrapped Khmer label adds a second line. Every screen's bottom padding and
   * every sticky bar above the nav derives from that token, so the constant
   * under-reserved by 15-24px — the shape of the defect where the nav covers
   * the control beneath it.
   */
  it("--nav-clearance prefers the measured height over the static guess", () => {
    expect(styles).toContain("--nav-measured-height");
    const declaration = /--nav-clearance:\s*var\(\s*--nav-measured-height\s*,/.exec(styles);
    expect(declaration).not.toBeNull();
  });

  it("the static token survives as the pre-hydration fallback", () => {
    // Server-rendered frames and the desktop bar still need a real number.
    expect(styles).toMatch(/--nav-measured-height,\s*calc\(var\(--nav-height\)/);
  });

  it("BottomNav measures itself and publishes that height", () => {
    expect(bottomNav).toContain("ResizeObserver");
    expect(bottomNav).toContain("--nav-measured-height");
    // Removed when the mobile nav is not the one displayed, so the fallback —
    // which matches the fixed-height desktop bar — applies again.
    expect(bottomNav).toContain("removeProperty");
  });

  it("the mobile nav label has no horizontal padding competing with its tab", () => {
    // Those 4px were the difference between a Khmer label fitting on one line
    // at 390/430 and wrapping to two.
    expect(bottomNav).toContain('"chip-text block max-w-full text-[11px] leading-[13px]"');
  });
});

describe("Khmer chip text wraps inside its box instead of escaping it", () => {
  it("the Khmer chip rule supplies a break opportunity", () => {
    /*
     * `white-space: normal` only PERMITS a wrap. Khmer has no spaces, so it
     * offered no break opportunity and the label painted straight out of its
     * box — across the neighbouring tab's tap target, with nothing clipped to
     * show for it. Proven in a real browser by
     * mobile-khmer-nav-fit.browser.ts; pinned here so the declaration cannot
     * be dropped without a failing test in the default suite.
     */
    const rule = /\[data-lang="km"\]\s*\.chip-text\s*\{([^}]*)\}/.exec(styles);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("overflow-wrap: anywhere");
    expect(rule![1]).toContain("white-space: normal");
  });
});
