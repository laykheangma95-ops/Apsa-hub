/**
 * Khmer nav labels must stay inside their own tab — real-browser regression.
 *
 * The unit half of this question (mobile-nav-clearance.test.ts) can only read
 * the CSS rule; it cannot answer the one that produced the bug: *does the
 * browser actually keep this text inside this box?* Khmer has no spaces, so
 * `white-space: normal` permits a wrap without ever creating one. Measured in
 * Chromium against the real stylesheet at 320px, the bottom-nav Inbox label
 * (ប្រអប់សារ) painted 66px wide inside a 57px tab and ran 13px past it, over
 * the neighbouring tab's tap target; at 360px it still crossed by 3px. Nothing
 * was clipped — `overflow: visible` meant the text simply escaped — so no
 * scrollWidth check and no static inspection could see it. Only the painted
 * geometry could.
 *
 * So this file drives real Chromium over the DevTools protocol against the
 * REAL built stylesheet, measures the painted text with a Range (not the
 * element box, which `overflow: visible` makes useless here), and asserts
 * containment at each target phone width.
 *
 * The five labels are the shipped Khmer nav strings from src/locales/km.json,
 * and the box geometry is the shipped tab geometry: a 5-column grid inside the
 * mobile nav's own padding at that width.
 *
 * Skips (loudly) when no Chromium is found, or when the production stylesheet
 * has not been built — this asserts against shipped CSS, so a guess would be
 * worse than an honest skip.
 *
 * Run: bun run build && bun test ./src/tests/mobile-khmer-nav-fit.browser.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Playwright's cache first (what CI and the dev container ship), then the OS. */
function findBrowser(): string | null {
  const candidates = [
    process.env["APSA_CHROME_PATH"],
    process.env["CHROME_PATH"],
    process.env["PLAYWRIGHT_BROWSERS_PATH"]
      ? path.join(process.env["PLAYWRIGHT_BROWSERS_PATH"], "chromium")
      : undefined,
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The built stylesheet. This suite is only meaningful against shipped CSS. */
function findStylesheet(): string | null {
  const dir = path.resolve(".output/public/assets");
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find((f) => f.startsWith("styles-") && f.endsWith(".css"));
  return match ? path.join(dir, match) : null;
}

const BROWSER = findBrowser();
const STYLESHEET = findStylesheet();

if (!BROWSER) {
  console.warn(
    "[mobile-khmer-nav-fit.browser] SKIPPED — no Chromium/Chrome binary found. " +
      "Set APSA_CHROME_PATH to run the Khmer nav-fit regression.",
  );
}
if (BROWSER && !STYLESHEET) {
  console.warn(
    "[mobile-khmer-nav-fit.browser] SKIPPED — no built stylesheet at " +
      ".output/public/assets/styles-*.css. Run `bun run build` first; this " +
      "suite asserts against the CSS that actually ships.",
  );
}

/** The shipped Khmer nav labels (src/locales/km.json → nav.*). */
const KHMER_TABS = [
  { id: "home", label: "ទំព័រដើម" },
  { id: "inbox", label: "ប្រអប់សារ" },
  { id: "ask", label: "សួរ" },
  { id: "sales", label: "ការលក់" },
  { id: "my", label: "ខ្ញុំ" },
] as const;

/** The widths the launch-readiness audit treats as real phones. */
const WIDTHS = [320, 360, 390, 430] as const;

interface Measured {
  label: string;
  /** Painted text right edge minus the tab's right edge; > 0 means it escaped. */
  overflowRight: number;
  /** The tab's left edge minus the painted text left edge; > 0 means it escaped. */
  overflowLeft: number;
}

let child: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let ws: WebSocket | undefined;
let sessionId = "";
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/** A CDP reply. Shapes vary per method, so callers narrow what they read. */
interface CdpResult {
  [key: string]: unknown;
}

function send(method: string, params: unknown = {}, session?: string): Promise<CdpResult> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ id, method, params, sessionId: session }));
  });
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result["exceptionDetails"]) {
    throw new Error(JSON.stringify(result["exceptionDetails"]).slice(0, 600));
  }
  return (result["result"] as { value: T }).value;
}

/**
 * Waits for Chromium's own `DevTools listening on ws://...` announcement —
 * its explicit readiness signal — rather than polling the filesystem for the
 * DevToolsActivePort file, which a throttled CI runner can be slow to write.
 */
async function waitForEndpoint(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<string> {
  const stderr = proc.stderr;
  let buffered = "";

  const announcement =
    stderr instanceof ReadableStream
      ? (async (): Promise<string> => {
          const decoder = new TextDecoder();
          const reader = stderr.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Chromium's stderr closed before announcing an endpoint");
            buffered += decoder.decode(value, { stream: true });
            const match = /DevTools listening on (ws:\S+)/.exec(buffered);
            if (match) return match[1]!;
          }
        })()
      : Promise.reject(new Error("Chromium's stderr was not captured"));

  const exited = proc.exited.then((code): never => {
    throw new Error(`Chromium exited (code ${code}) before announcing a DevTools endpoint`);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([announcement, exited, timedOut]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nLast stderr:\n${buffered.slice(-2000) || "(empty)"}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shipped mobile nav geometry, reproduced in plain markup so the thing
 * under test is the CSS rule rather than the component tree: the nav's fixed
 * wrapper (px-2), its glass bar (px-1.5) and a 5-column grid whose cells carry
 * the tab's own px-0.5. The label span carries exactly the classes BottomNav
 * gives it.
 */
function fixtureHtml(css: string): string {
  const cells = KHMER_TABS.map(
    (tab) =>
      `<div class="tab" data-tab="${tab.id}">` +
      `<span class="chip-text block max-w-full text-[11px] leading-[13px]" data-label="${tab.id}">${tab.label}</span>` +
      `</div>`,
  ).join("");

  return (
    '<!doctype html><html lang="km" data-lang="km"><meta charset="utf-8">' +
    /* Without this, mobile emulation lays the page out at ~980px and every
       tab measures far wider than it does on a phone — the constraint under
       test disappears and the suite passes vacuously. */
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>khmer nav fit</title><style>" +
    css +
    `
    /* The shipped nav's own box model and type stack, nothing else.
       The font matters: Khmer metrics differ per face, and measuring the
       default serif instead of the app's own stack measures the wrong glyphs. */
    body { margin: 0; font-family: var(--font-sans); }
    #wrapper { position: fixed; inset-inline: 0; bottom: 0; padding-inline: 0.5rem; }
    #bar { margin-inline: auto; max-width: var(--screen-max); padding-inline: 0.375rem; }
    #grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.125rem; }
    .tab {
      min-width: 0;
      padding-inline: 0.125rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    ` +
    '</style><body><div id="wrapper"><div id="bar"><div id="grid">' +
    cells +
    "</div></div></div>"
  );
}

describe("Khmer bottom-nav labels stay inside their own tab", () => {
  const runnable = Boolean(BROWSER && STYLESHEET);

  beforeAll(async () => {
    if (!runnable) return;

    const css = fs.readFileSync(STYLESHEET!, "utf8");
    const html = fixtureHtml(css);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
    });

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apsa-khmer-nav-"));
    child = Bun.spawn(
      [
        BROWSER!,
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--disable-dev-shm-usage",
        "about:blank",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );

    const endpoint = await waitForEndpoint(child, 30_000);
    ws = new WebSocket(endpoint);
    await new Promise((resolve) => {
      ws!.onopen = resolve;
    });
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
    };

    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const attached = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    sessionId = attached.sessionId;
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
  });

  afterAll(() => {
    ws?.close();
    child?.kill();
    server?.stop(true);
  });

  for (const width of WIDTHS) {
    it(`contains every Khmer label at ${width}px`, async () => {
      if (!runnable) return;

      await send(
        "Emulation.setDeviceMetricsOverride",
        { width, height: 780, deviceScaleFactor: 2, mobile: true },
        sessionId,
      );
      await send("Page.navigate", { url: server!.url.href }, sessionId);
      await Bun.sleep(400);

      /*
       * Measured with a Range, not with the span's own rect. The Khmer rule
       * sets `overflow: visible`, so the element box reports its constrained
       * width while the glyphs paint outside it — the element box is exactly
       * the measurement that could not see this bug.
       */
      const measured = await evaluate<Measured[]>(`(() => {
        return [...document.querySelectorAll('.tab')].map((tab) => {
          const label = tab.querySelector('[data-label]');
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = tab.getBoundingClientRect();
          return {
            label: label.textContent,
            overflowRight: text.right - box.right,
            overflowLeft: box.left - text.left,
          };
        });
      })()`);

      expect(measured).toHaveLength(KHMER_TABS.length);

      for (const entry of measured) {
        // Sub-pixel slack only. A whole pixel past the edge is a glyph sitting
        // on the neighbouring tab's tap target.
        expect({
          label: entry.label,
          escapedRight: entry.overflowRight > 1,
          escapedLeft: entry.overflowLeft > 1,
        }).toEqual({ label: entry.label, escapedRight: false, escapedLeft: false });
      }
    });
  }
});
