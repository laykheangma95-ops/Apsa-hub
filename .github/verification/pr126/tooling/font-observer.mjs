/**
 * Observe-only wrapper around playwright-core for PR #126's mobile harness.
 *
 * scripts/products-mobile-harness.ts loads Playwright from APSA_PLAYWRIGHT_CORE
 * and uses only `chromium.launch`. Pointing that variable here runs the
 * committed harness unchanged while recording, to APSA_FONT_LOG (JSON lines):
 *   - the browser's version and executable;
 *   - before every page.evaluate (the harness's layout measurements) and every
 *     screenshot: document.fonts.status and the Kantumruy Pro / Plus Jakarta
 *     Sans faces' load states.
 *
 * It never waits for fonts or changes the page, so the harness measures what it
 * would have measured anyway; this only reports whether the web fonts had
 * loaded by then.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import playwright from "playwright-core";

const log = process.env.APSA_FONT_LOG;
if (!log) throw new Error("APSA_FONT_LOG is required");
const write = (entry) =>
  appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

// Runs in the page.
const probe = () => {
  const faces = [...document.fonts].filter((face) => /Kantumruy|Jakarta/.test(face.family));
  const loaded = (family) =>
    faces.filter((face) => face.family.includes(family) && face.status === "loaded").length;
  return {
    url: location.pathname,
    lang: document.documentElement.lang,
    status: document.fonts.status,
    kantumruyLoaded: loaded("Kantumruy"),
    jakartaLoaded: loaded("Jakarta"),
    faces: faces.map((face) => `${face.family} ${face.weight} ${face.status}`),
    hasKhmerText: /[ក-៿]/.test(document.body?.innerText ?? ""),
  };
};

function observe(page) {
  const evaluate = page.evaluate.bind(page);
  const screenshot = page.screenshot.bind(page);
  const record = async (kind, file) => {
    try {
      write({ kind, file, viewport: page.viewportSize(), ...(await evaluate(probe)) });
    } catch (error) {
      write({ kind, file, error: String(error).slice(0, 300) });
    }
  };
  page.evaluate = async (...args) => {
    await record("evaluate");
    return evaluate(...args);
  };
  page.screenshot = async (options = {}) => {
    await record("screenshot", options.path ? path.basename(options.path) : undefined);
    return screenshot(options);
  };
  return page;
}

export const chromium = {
  async launch(options) {
    const browser = await playwright.chromium.launch(options);
    write({
      kind: "browser",
      version: browser.version(),
      executablePath: options?.executablePath ?? playwright.chromium.executablePath(),
    });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await newContext(contextOptions);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => observe(await newPage());
      return context;
    };
    return browser;
  },
};

export default { chromium };
