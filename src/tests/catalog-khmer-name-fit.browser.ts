/**
 * Khmer product names stay inside their row, in BOTH interface languages —
 * real-browser regression.
 *
 * The Products and Inventory rows mark the product name `lang="km"` and render
 * it in `.chip-text`. Until the `.text-label[lang="km"] > .chip-text` rule,
 * only the Khmer interface let that text wrap; in the English interface it
 * kept `.chip-text`'s nowrap, and `overflow: hidden` on an inline span clips
 * nothing. Measured on /app/products in Chromium with Kantumruy Pro loaded, a
 * long Khmer name painted as one line to x=513 in a row ending at 303 (320px
 * wide), straight across the price — the same at 360, 390 and 430.
 *
 * Like mobile-khmer-nav-fit.browser.ts, this drives real Chromium over the
 * DevTools protocol against the REAL built stylesheet, and measures the painted
 * text line by line with a Range. The row markup below carries exactly the
 * classes ProductRow (src/routes/app.products.tsx) and InventoryListRow
 * (src/routes/app.inventory.tsx) give it; product-catalog-ui.test.ts pins those
 * classes so this fixture cannot drift from them silently.
 *
 * The app's own web fonts are loaded and awaited before anything is measured:
 * Khmer metrics differ per face, and a measurement taken on a fallback face is
 * a measurement of the wrong glyphs. If Kantumruy Pro does not load, the case
 * FAILS rather than measuring anyway.
 *
 * Skips (loudly) when no Chromium is found or the stylesheet is not built.
 *
 * Run: bun run build && bun test ./src/tests/catalog-khmer-name-fit.browser.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    "[catalog-khmer-name-fit.browser] SKIPPED — no Chromium/Chrome binary found. " +
      "Set APSA_CHROME_PATH to run the Khmer product-name fit regression.",
  );
}
if (BROWSER && !STYLESHEET) {
  console.warn(
    "[catalog-khmer-name-fit.browser] SKIPPED — no built stylesheet at " +
      ".output/public/assets/styles-*.css. Run `bun run build` first.",
  );
}

/** src/routes/__root.tsx's font stylesheet, as the app links it. */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Kantumruy+Pro:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap";

/** The names the mobile harness seeds (scripts/products-mobile-harness.ts), and a short one. */
const NAMES = {
  longKhmer:
    "ទឹកក្រូចច្របាច់ស្រស់ធម្មជាតិគ្មានជាតិស្ករបន្ថែម ខ្ចប់ក្នុងដបកែវធំសម្រាប់គ្រួសារ និងការជប់លៀងពិសេស",
  unbroken: "APSA-ORANGE-JUICE-FAMILY-GLASS-BOTTLE-1500ML-NO-SUGAR-2026-LOT-0001",
  short: "កាហ្វេ 001",
} as const;

const WIDTHS = [320, 360, 390, 430] as const;
const LANGS = ["en", "km"] as const;

/** ProductRow's markup (classes verbatim), with a price that must stay whole. */
function productRow(id: string, name: string): string {
  return (
    `<a data-row="${id}" class="press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left">` +
    `<div class="flex min-w-0 items-baseline gap-2">` +
    `<span class="text-label min-w-0 flex-1 text-text-primary" lang="km"><span class="chip-text" data-name>${name}</span></span>` +
    `<span class="text-financial tnum shrink-0 text-text-primary" data-end>$2.50</span>` +
    `</div>` +
    `<span class="text-caption min-w-0 truncate text-text-secondary" lang="en">Freshly squeezed natural orange juice</span>` +
    `</a>`
  );
}

/** InventoryListRow's markup (classes verbatim), with its quantity on the right. */
function inventoryRow(id: string, name: string): string {
  return (
    `<a data-row="${id}" class="press flex w-full items-start justify-between gap-3 border-b border-border-default bg-surface-primary px-4 py-3 text-left">` +
    `<span class="flex min-w-0 flex-1 flex-col gap-1">` +
    `<span class="text-label min-w-0 text-text-primary" lang="km"><span class="chip-text" data-name>${name}</span></span>` +
    `</span>` +
    `<span class="text-financial tnum shrink-0" data-end>1,250</span>` +
    `</a>`
  );
}

function fixtureHtml(css: string, lang: (typeof LANGS)[number]): string {
  const rows = Object.entries(NAMES)
    .flatMap(([key, name]) => [
      productRow(`product-${key}`, name),
      inventoryRow(`inventory-${key}`, name),
    ])
    .join("");
  return (
    `<!doctype html><html lang="${lang}" data-lang="${lang}"><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<link rel="stylesheet" href="${FONTS}">` +
    "<title>khmer name fit</title><style>" +
    css +
    "\nbody { margin: 0; font-family: var(--font-sans); }\n" +
    "</style><body><main>" +
    rows +
    "</main>"
  );
}

interface Measured {
  row: string;
  lines: number;
  /** Lines that run past the row's right edge or into the price/quantity. */
  overruns: string[];
  /** The price/quantity box lies wholly inside the row. */
  endInside: boolean;
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

describe("Khmer product names stay inside their row in the English and Khmer UI", () => {
  const runnable = Boolean(BROWSER && STYLESHEET);
  const html: Record<string, string> = {};

  beforeAll(async () => {
    if (!runnable) return;
    const css = fs.readFileSync(STYLESHEET!, "utf8");
    for (const lang of LANGS) html[lang] = fixtureHtml(css, lang);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new Response(html[new URL(request.url).pathname.slice(1)] ?? "", {
          headers: { "content-type": "text/html" },
        }),
    });

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apsa-khmer-name-"));
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

  for (const lang of LANGS) {
    for (const width of WIDTHS) {
      it(`${lang} UI at ${width}px: every line of every name clears the price and the row edge`, async () => {
        if (!runnable) return;

        await send(
          "Emulation.setDeviceMetricsOverride",
          { width, height: 900, deviceScaleFactor: 2, mobile: true },
          sessionId,
        );
        await send("Page.navigate", { url: `${server!.url.href}${lang}` }, sessionId);

        // Fonts first: the page has loaded, the Khmer face has loaded, and
        // nothing else is still loading. Never measured on a fallback face.
        const fonts = await evaluate<{ kantumruy: number; status: string }>(`(async () => {
          const deadline = Date.now() + 20000;
          while (document.readyState !== "complete" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await document.fonts.load('16px "Kantumruy Pro"', "ក");
          await document.fonts.ready;
          return {
            kantumruy: [...document.fonts].filter(
              (face) => face.family.includes("Kantumruy") && face.status === "loaded",
            ).length,
            status: document.fonts.status,
          };
        })()`);
        expect(fonts.status).toBe("loaded");
        expect(fonts.kantumruy).toBeGreaterThan(0);

        const measured = await evaluate<Measured[]>(`(() => {
          return [...document.querySelectorAll("[data-row]")].map((row) => {
            const name = row.querySelector("[data-name]");
            const end = row.querySelector("[data-end]").getBoundingClientRect();
            const box = row.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(name);
            const lines = [...range.getClientRects()];
            const overruns = lines
              .filter(
                (line) =>
                  line.right > box.right + 0.5 ||
                  line.left < box.left - 0.5 ||
                  (line.right > end.left + 0.5 && line.top < end.bottom && line.bottom > end.top),
              )
              .map((line) => Math.round(line.left) + "-" + Math.round(line.right));
            return {
              row: row.dataset.row,
              lines: lines.length,
              overruns,
              endInside: end.left >= box.left - 0.5 && end.right <= box.right + 0.5,
            };
          });
        })()`);

        expect(measured).toHaveLength(Object.keys(NAMES).length * 2);
        for (const entry of measured) {
          expect({ row: entry.row, overruns: entry.overruns, endInside: entry.endInside }).toEqual({
            row: entry.row,
            overruns: [],
            endInside: true,
          });
        }
        // The long Khmer name had to wrap to fit; a one-line pass would mean
        // the fixture no longer exercises the case.
        const longKhmer = measured.find((entry) => entry.row === "product-longKhmer")!;
        expect(longKhmer.lines).toBeGreaterThan(1);

        const sideways = await evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        );
        expect(sideways).toBeLessThanOrEqual(1);
      }, 60_000);
    }
  }
});
