/**
 * Font-settling wrapper around playwright-core for PR #126's mobile harness.
 *
 * scripts/products-mobile-harness.ts loads Playwright from APSA_PLAYWRIGHT_CORE
 * and uses only `chromium.launch`. Pointing that variable here runs the
 * committed harness unchanged, except that before every page.evaluate (the
 * harness's layout measurements) and every screenshot it waits, at most
 * FONT_WAIT_MS, for the Khmer web font (when the page shows Khmer) and for
 * document.fonts.ready. Run 39348541760 showed the harness otherwise measuring
 * before Kantumruy Pro had loaded. It records, to APSA_FONT_LOG (JSON lines):
 *   - the browser's version and executable;
 *   - at each of those points: how long it waited, whether the wait timed out,
 *     then document.fonts.status and the Kantumruy Pro / Plus Jakarta Sans
 *     faces' load states.
 *
 * It changes no page state and no assertion; it only delays. At each
 * `*-list.png` screenshot it also repeats the harness's long-Khmer-name check
 * read-only (see longNameOverrun).
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

/**
 * The harness's own long-name check (scripts/products-mobile-harness.ts at
 * 5042656, "every line of the Khmer name clears the price and the row edge"),
 * repeated as-is at the `*-list.png` screenshot, i.e. moments later on the same
 * page with nothing done in between. The harness's verdict is untouched; this
 * records what the same check reads once the page's fonts have had that time.
 * Runs in the page.
 */
const longNameOverrun = (prefix) => {
  const row = [...document.querySelectorAll('main a[href^="/app/products/"]')].find((a) =>
    (a.textContent ?? "").includes(prefix),
  );
  if (!row) return "row not found";
  const name = row.querySelector('[lang="km"] .chip-text');
  const price = row.querySelector(".text-financial");
  if (!name || !price) return "name or price not found";
  const range = document.createRange();
  range.selectNodeContents(name);
  const priceBox = price.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const lines = [...range.getClientRects()];
  const bad = lines.filter(
    (line) =>
      line.right > rowBox.right + 0.5 ||
      (line.right > priceBox.left + 0.5 &&
        line.top < priceBox.bottom &&
        line.bottom > priceBox.top),
  );
  return bad.length
    ? `${bad.length}/${lines.length} lines overrun (max right ${Math.round(Math.max(...bad.map((b) => b.right)))}, price left ${Math.round(priceBox.left)}, row right ${Math.round(rowBox.right)})`
    : "";
};
// The harness's LONG_KM, and the 12-character prefix it finds the row by.
const LONG_KM_PREFIX =
  "ទឹកក្រូចច្របាច់ស្រស់ធម្មជាតិគ្មានជាតិស្ករបន្ថែម ខ្ចប់ក្នុងដបកែវធំសម្រាប់គ្រួសារ និងការជប់លៀងពិសេស".slice(
    0,
    12,
  );

const FONT_WAIT_MS = 15_000;

// Runs in the page. Never rejects: a failed or slow load is reported, and the
// readiness check in summarize.ts then fails the point.
const settleFonts = async (timeoutMs) => {
  const started = performance.now();
  const khmer = /[ក-៿]/.test(document.body?.innerText ?? "");
  const settle = (async () => {
    if (khmer) await document.fonts.load('16px "Kantumruy Pro"', "ក");
    await document.fonts.ready;
    return "settled";
  })().catch((error) => `load failed: ${String(error).slice(0, 120)}`);
  const timer = new Promise((resolve) => setTimeout(() => resolve("timed out"), timeoutMs));
  const outcome = await Promise.race([settle, timer]);
  return { fontWait: outcome, fontWaitMs: Math.round(performance.now() - started) };
};

function observe(page) {
  const evaluate = page.evaluate.bind(page);
  const screenshot = page.screenshot.bind(page);
  const remeasure = async (file) => {
    try {
      const state = await evaluate(probe);
      const overrun = await evaluate(longNameOverrun, LONG_KM_PREFIX);
      write({
        kind: "long-name-remeasure",
        file,
        viewport: page.viewportSize(),
        ...state,
        overrun,
      });
    } catch (error) {
      write({ kind: "long-name-remeasure", file, error: String(error).slice(0, 300) });
    }
  };
  const record = async (kind, file) => {
    try {
      const settled = await evaluate(settleFonts, FONT_WAIT_MS);
      write({ kind, file, viewport: page.viewportSize(), ...settled, ...(await evaluate(probe)) });
    } catch (error) {
      write({ kind, file, error: String(error).slice(0, 300) });
    }
  };
  page.evaluate = async (...args) => {
    await record("evaluate");
    return evaluate(...args);
  };
  page.screenshot = async (options = {}) => {
    const file = options.path ? path.basename(options.path) : undefined;
    await record("screenshot", file);
    if (file?.endsWith("-list.png")) await remeasure(file);
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
