/**
 * Parcel label — REAL rendered geometry in Chromium (P1: long-address overflow).
 *
 * The label is server-rendered exactly as the dialog prints it (<LabelSheet>
 * pages wrapping <ParcelLabel>), styled with the PRODUCTION Tailwind CSS from
 * the build output, loaded in headless Chromium with print media emulated, and
 * measured in millimetres. For every fixture — long Khmer/English names,
 * ~300/~500/max-length addresses, 8+ items, COD / PAID / CHECK, carrier present
 * and absent — it proves:
 *
 *   - each page is exactly 100 × 150 mm and the PDF has one page per parcel;
 *   - the payment box, APSA Parcel ID box, tracking Code 128 slot and footer lie
 *     fully inside the page (CORRECTION-003: the shipping label shows the APSA
 *     Parcel ID as text; its one barcode is the carrier tracking number);
 *   - nothing in the top block (receiver, address, carrier, items) reaches the
 *     payment box — no item line is clipped or overlaps it, the "+N more" note
 *     is visible, and the COD amount is the topmost element at its own centre;
 *   - a long address is shortened with a visible continuation marker, never
 *     silently clipped.
 *
 * Runs in the normal `bun test src/tests/` CI job (the Test-suite job downloads
 * the build output). On CI a missing browser or build CSS is a FAILURE, not a
 * skip; locally it skips loudly (run `bun run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "@/lib/i18n";
import { LabelSheet } from "@/components/labels/LabelSheet";
import { ParcelLabel } from "@/components/labels/ParcelLabel";
import {
  buildParcelLabel,
  PARCEL_LABEL_SIZE_MM,
  type ParcelLabelInput,
} from "@/lib/labels/parcel-label";

// ── Environment ───────────────────────────────────────────────────────────────

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
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBuildCss(): string | null {
  const dir = path.resolve(".output/public/assets");
  if (!fs.existsSync(dir)) return null;
  const sheets = fs.readdirSync(dir).filter((f) => /^styles-.*\.css$/.test(f));
  return sheets.length > 0 ? path.join(dir, sheets[0]!) : null;
}

const BROWSER = findBrowser();
const CSS_PATH = findBuildCss();
const ON_CI = !!process.env["CI"];
const READY = !!BROWSER && !!CSS_PATH;
if (!READY && !ON_CI) {
  console.warn(
    "[parcel-label-layout] SKIPPED — " +
      (!BROWSER ? "no Chromium/Chrome binary (set APSA_CHROME_PATH). " : "") +
      (!CSS_PATH ? "no build CSS in .output/public/assets (run `bun run build`)." : ""),
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PARCEL_CODE = "APSA:PCL:v1:AbCdEfGhIjKlMnOpQrStUv";
const FIXED_NOW = new Date("2026-10-01T10:30:00Z");
const KM_ADDRESS =
  "ផ្ទះលេខ ១២៣ ផ្លូវ ២៤០ ភូមិ១ សង្កាត់បឹងកេងកង១ ខណ្ឌចំការមន រាជធានីភ្នំពេញ " +
  "ទល់មុខផ្សារ ក្បែរវត្តលង្កា ច្រកទី៣ ផ្ទះពណ៌ស ទ្វារដែកខៀវ ";
const EN_ADDRESS =
  "No. 123, Street 240, Village 1, Sangkat Boeung Keng Kang 1, Khan Chamkar Mon, " +
  "Phnom Penh, opposite the market near Wat Langka, third alley, white house, blue gate. ";

function repeatTo(text: string, length: number): string {
  return text.repeat(Math.ceil(length / text.length) + 1).slice(0, length);
}

function items(count: number, name = "Iced Coffee", variant: string | null = "Large") {
  return Array.from({ length: count }, (_, i) => ({
    quantity: (i % 3) + 1,
    productName: `${name} ${i + 1}`,
    variantName: variant,
  }));
}

const COD = { state: "cod" as const, collect: { amount: 1234500, currency: "KHR" as const } };
const PAID = { state: "paid" as const, collect: null };
const CHECK = { state: "check" as const, collect: null, checkReason: "payment_review" as const };
const CARRIER = {
  providerName: "VET Express Logistics Cambodia",
  trackingNumber: "VET-2026-0001234567890",
  status: "ready",
  serviceName: null,
};

function fixture(
  id: string,
  over: {
    name?: string;
    address?: string;
    items?: ReturnType<typeof items>;
    payment?: ParcelLabelInput["payment"];
    delivery?: ParcelLabelInput["delivery"];
    shop?: string;
  },
): { id: string; input: ParcelLabelInput } {
  const lines = over.items ?? items(2);
  return {
    id,
    input: {
      merchant: { businessName: over.shop ?? "APSA Coffee", phone: "012 000 111" },
      customer: {
        name: over.name ?? "Sokha Chan",
        phone: "+855 12 345 678",
        address: over.address ?? "12 St 240, BKK1, Phnom Penh",
        addressConfirmed: true,
      },
      order: {
        id: "00000000-0000-4000-8000-000000000001",
        orderNumber: "APSA-2026-001048",
        itemCount: lines.reduce((s, l) => s + l.quantity, 0),
        items: lines,
      },
      reprint: true,
      payment: over.payment ?? COD,
      delivery: over.delivery === undefined ? CARRIER : over.delivery,
      parcelCode: PARCEL_CODE,
    },
  };
}

const LONG_KM_NAME = repeatTo("សុខា ចាន់ សុភ័ក្រ្ត ", 200);
const LONG_EN_NAME = repeatTo("Sokha Chanthavy Sophearith Vannarith ", 200);
const LONG_ITEM = "កាហ្វេទឹកដោះគោត្រជាក់ពិសេស Extra Large Premium Blend";

const LAYOUT_FIXTURES = [
  fixture("short-cod", {}),
  fixture("paid-no-carrier", { payment: PAID, delivery: null }),
  fixture("check-payment", { payment: CHECK }),
  fixture("long-km-name", { name: LONG_KM_NAME, items: items(8) }),
  fixture("long-en-name", { name: LONG_EN_NAME, items: items(8) }),
  fixture("km-address-300", { address: repeatTo(KM_ADDRESS, 300), items: items(8) }),
  fixture("en-address-300", { address: repeatTo(EN_ADDRESS, 300), items: items(8) }),
  fixture("km-address-500", { address: repeatTo(KM_ADDRESS, 500), items: items(10) }),
  fixture("en-address-500", { address: repeatTo(EN_ADDRESS, 500), payment: CHECK }),
  fixture("km-address-max", {
    name: LONG_KM_NAME,
    address: repeatTo(KM_ADDRESS, 1000),
    items: items(12, LONG_ITEM, "ធំ"),
  }),
  fixture("en-address-max-paid", {
    name: LONG_EN_NAME,
    address: repeatTo(EN_ADDRESS, 1000),
    items: items(12, "Iced Coffee Extra Large Premium Blend Special", "Large / Oat milk"),
    payment: PAID,
    shop: repeatTo("APSA Coffee Roasters Toul Kork Branch ", 120),
  }),
  fixture("many-items-no-carrier", { items: items(14, LONG_ITEM, "ធំ"), delivery: null }),
];

// ── Measurement ───────────────────────────────────────────────────────────────

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
interface Measured {
  id: string;
  page: Box;
  label: Box;
  top: Box;
  bottom: Box;
  payment: Box;
  /** The 30 mm APSA Parcel box: small QR + Parcel ID (secondary identifier). */
  apsaId: Box;
  /** The small APSA Parcel QR inside it. */
  apsaQr: Box | null;
  code128: Box | null;
  /** The tracking barcode SVG, or its same-size "no tracking" placeholder. */
  code128Slot: Box | null;
  code128Svg: Box | null;
  footer: Box;
  itemsSection: Box;
  itemLines: Box[];
  moreItems: Box | null;
  receiverSections: Box[];
  address: { box: Box; scrollHeight: number; clientHeight: number } | null;
  addressTruncated: Box | null;
  codAmount: Box | null;
  codAmountOnTop: boolean | null;
}

/** Runs in the page: every box in mm relative to its own label page. */
const MEASURE = `(() => {
  const PX_PER_MM = 96 / 25.4;
  const results = [...document.querySelectorAll('.apsa-label-page')].map((page) => {
    const p = page.getBoundingClientRect();
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const mm = (v) => Math.round((v / PX_PER_MM) * 100) / 100;
      return { top: mm(r.top - p.top), bottom: mm(r.bottom - p.top), left: mm(r.left - p.left),
        right: mm(r.right - p.left), width: mm(r.width), height: mm(r.height) };
    };
    const q = (s) => page.querySelector('[data-testid="' + s + '"]');
    const address = q('parcel-label-address');
    const cod = q('parcel-label-cod-amount');
    const top = q('parcel-label-top');
    return {
      id: page.querySelector('[data-fixture]')?.getAttribute('data-fixture'),
      page: box(page), label: box(q('parcel-label')), top: box(top), bottom: box(q('parcel-label-bottom')),
      payment: box(q('parcel-label-payment')), apsaId: box(q('parcel-label-apsa-id')),
      apsaQr: box(q('parcel-label-apsa-qr')?.querySelector('svg')),
      code128: box(q('parcel-label-code128')),
      code128Slot: box(q('parcel-label-code128')?.querySelector('svg') ?? q('parcel-label-code128')?.firstElementChild),
      code128Svg: box(q('parcel-label-code128')?.querySelector('svg')),
      footer: box(q('parcel-label-footer')), itemsSection: box(q('parcel-label-items')),
      itemLines: [...page.querySelectorAll('[data-testid="parcel-label-items"] li')].map(box),
      moreItems: box(q('parcel-label-more-items')),
      receiverSections: [...top.children].filter((c) => c.getAttribute('data-testid') !== 'parcel-label-items').map(box),
      address: address ? { box: box(address), scrollHeight: address.scrollHeight, clientHeight: address.clientHeight } : null,
      addressTruncated: box(q('parcel-label-address-truncated')),
      codAmount: box(cod), codAmountOnTop: null,
    };
  });
  // Second pass, after every box is measured (scrolling moves the pages): is
  // the COD amount the topmost element at its own centre?
  const pages = [...document.querySelectorAll('.apsa-label-page')];
  pages.forEach((page, i) => {
    const cod = page.querySelector('[data-testid="parcel-label-cod-amount"]');
    if (!cod) return;
    cod.scrollIntoView({ block: 'center', inline: 'center' });
    const r = cod.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    results[i].codAmountOnTop = !!hit && (hit === cod || cod.contains(hit));
  });
  return results;
})()`;

function renderSheet(fixtures: typeof LAYOUT_FIXTURES, css: string): string {
  const pages = fixtures.map((f) =>
    createElement(
      "div",
      { key: f.id, "data-fixture": f.id, style: { height: "100%" } },
      createElement(ParcelLabel, { vm: buildParcelLabel(f.input, { now: FIXED_NOW }) }),
    ),
  );
  const sheet = renderToStaticMarkup(
    createElement(LabelSheet, {
      open: true,
      onClose: () => {},
      title: "layout",
      pageSize: PARCEL_LABEL_SIZE_MM,
      printable: true,
      children: pages,
    }),
  );
  // The sheet is mounted inside an app-like shell — a viewport-height,
  // overflow-hidden layout with a sidebar and tall page content — exactly the
  // situation in which a fixed overlay used to print repeated, overlapping
  // labels with a page count set by the app behind it.
  return (
    `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>${css}</style></head><body>` +
    `<div class="flex h-screen overflow-hidden"><aside style="width:240px;height:2000px">nav</aside>` +
    `<main class="relative flex-1 overflow-auto p-6"><div style="height:3000px">app content</div>` +
    `${sheet}</main></div></body></html>`
  );
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

async function openPage(browser: string, html: string): Promise<Cdp> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apsa-parcel-layout-"));
  const child = Bun.spawn(
    [
      browser,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--mute-audio",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const teardown = async () => {
    child.kill();
    await child.exited;
    server.stop(true);
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    let stderr = "";
    const decoder = new TextDecoder();
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + 20_000;
    let ws: string | null = null;
    while (!ws) {
      if (Date.now() > deadline) throw new Error(`No DevTools endpoint.\n${stderr.slice(-2000)}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`Chromium exited.\n${stderr.slice(-2000)}`);
      stderr += decoder.decode(value, { stream: true });
      ws = stderr.match(/ws:\/\/[^\s]+/)?.[0] ?? null;
    }
    void (async () => {
      while (!(await reader.read()).done);
    })().catch(() => {});
    const host = new URL(ws.replace(/^ws:/, "http:")).host;
    const target = (await fetch(`http://${host}/json/new?about:blank`, { method: "PUT" }).then(
      (r) => r.json(),
    )) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), {
        once: true,
      });
    });
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const events: Array<{ method: string }> = [];
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) {
        if (msg.method) events.push({ method: msg.method });
        return;
      }
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 30_000);
      });

    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    const loadDeadline = Date.now() + 20_000;
    while (!events.some((e) => e.method === "Page.loadEventFired")) {
      if (Date.now() > loadDeadline) throw new Error("page load timed out");
      await Bun.sleep(25);
    }
    await send("Emulation.setEmulatedMedia", { media: "print" });
    return {
      send,
      close: async () => {
        socket.close();
        await teardown();
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = (await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value: T }; exceptionDetails?: { text: string } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

/** Page objects in a PDF, including those inside compressed object streams. */
function pdfPageCount(pdfBase64: string): number {
  const bytes = Buffer.from(pdfBase64, "base64");
  const raw = bytes.toString("latin1");
  let text = raw;
  const streamRe = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try {
      text += inflateSync(bytes.subarray(start, end)).toString("latin1");
    } catch {
      // Not a Flate stream (fonts, images) — irrelevant to page objects.
    }
    streamRe.lastIndex = end;
  }
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/** Sub-pixel rounding tolerance, in mm. */
const EPS = 0.3;

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.top >= outer.top - EPS &&
    inner.bottom <= outer.bottom + EPS &&
    inner.left >= outer.left - EPS &&
    inner.right <= outer.right + EPS
  );
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.left < b.right - EPS &&
    b.left < a.right - EPS &&
    a.top < b.bottom - EPS &&
    b.top < a.bottom - EPS
  );
}

const PAGE_BOX: Box = {
  top: 0,
  bottom: PARCEL_LABEL_SIZE_MM.height,
  left: 0,
  right: PARCEL_LABEL_SIZE_MM.width,
  width: PARCEL_LABEL_SIZE_MM.width,
  height: PARCEL_LABEL_SIZE_MM.height,
};

describe.skipIf(!READY && !ON_CI)("parcel label — rendered geometry in Chromium", () => {
  let cdp: Cdp | null = null;
  let measured: Measured[] = [];
  let pdfPages = 0;

  beforeAll(async () => {
    if (!BROWSER) throw new Error("CI: no Chromium/Chrome binary found (set APSA_CHROME_PATH)");
    if (!CSS_PATH) throw new Error("CI: build CSS missing in .output/public/assets");
    await i18n.changeLanguage("km");
    const html = renderSheet(LAYOUT_FIXTURES, fs.readFileSync(CSS_PATH, "utf8"));
    cdp = await openPage(BROWSER, html);
    measured = await evaluate<Measured[]>(cdp, MEASURE);
    if (process.env["APSA_LAYOUT_DUMP"]) {
      fs.writeFileSync(process.env["APSA_LAYOUT_DUMP"], JSON.stringify(measured, null, 1));
    }
    const pdf = (await cdp.send("Page.printToPDF", {
      preferCSSPageSize: true,
      printBackground: true,
    })) as { data: string };
    pdfPages = pdfPageCount(pdf.data);
    if (process.env["APSA_LAYOUT_PDF"]) {
      fs.writeFileSync(process.env["APSA_LAYOUT_PDF"], Buffer.from(pdf.data, "base64"));
    }
  }, 90_000);

  afterAll(async () => {
    await cdp?.close();
  });

  it("renders every fixture", () => {
    expect(measured.map((m) => m.id)).toEqual(LAYOUT_FIXTURES.map((f) => f.id));
  });

  it("each page is exactly 100 × 150 mm and the PDF has one page per parcel", () => {
    for (const m of measured) {
      expect(Math.abs(m.page.width - 100)).toBeLessThan(EPS);
      expect(Math.abs(m.page.height - 150)).toBeLessThan(EPS);
      expect(inside(m.label, PAGE_BOX)).toBe(true);
    }
    expect(pdfPages).toBe(LAYOUT_FIXTURES.length);
  });

  for (const { id } of LAYOUT_FIXTURES) {
    describe(id, () => {
      const get = () => measured.find((m) => m.id === id)!;

      it("payment box, APSA Parcel ID box, tracking Code 128 slot and footer lie fully inside the page", () => {
        const m = get();
        for (const box of [m.bottom, m.payment, m.apsaId, m.code128!, m.footer]) {
          expect(box).not.toBeNull();
          expect(inside(box, PAGE_BOX)).toBe(true);
        }
        // The APSA Parcel ID box keeps its full 30 mm; the tracking slot keeps
        // its full width and height whether or not a tracking number exists.
        expect(m.apsaId.width).toBeGreaterThanOrEqual(30 - EPS);
        expect(m.apsaId.height).toBeGreaterThanOrEqual(30 - EPS);
        expect(m.code128Slot!.width).toBeGreaterThanOrEqual(92 - EPS);
        expect(m.code128Slot!.height).toBeGreaterThanOrEqual(12 - EPS);
        const fixture = LAYOUT_FIXTURES.find((f) => f.id === id)!;
        // A tracking number always prints as a real barcode.
        if (fixture.input.delivery?.trackingNumber) {
          expect(m.code128Svg).not.toBeNull();
        }
        // The APSA Parcel QR is SMALL and secondary: it sits wholly inside its
        // 30 mm box, stays scannable (≥ 18 mm), and is far narrower than the
        // primary full-width tracking barcode.
        if (fixture.input.parcelCode) {
          expect(m.apsaQr).not.toBeNull();
          expect(inside(m.apsaQr!, m.apsaId)).toBe(true);
          expect(m.apsaQr!.width).toBeGreaterThanOrEqual(18 - EPS);
          expect(m.apsaQr!.width).toBeLessThan(m.code128Slot!.width / 3);
        }
      });

      it("nothing above reaches the payment box; no item line is clipped", () => {
        const m = get();
        expect(m.top.bottom).toBeLessThanOrEqual(m.bottom.top + EPS);
        for (const section of m.receiverSections) {
          expect(section.bottom).toBeLessThanOrEqual(m.top.bottom + EPS);
        }
        for (const line of m.itemLines) {
          expect(line.bottom).toBeLessThanOrEqual(m.itemsSection.bottom + EPS);
          expect(line.bottom).toBeLessThanOrEqual(m.payment.top);
        }
        if (m.moreItems) {
          expect(m.moreItems.bottom).toBeLessThanOrEqual(m.itemsSection.bottom + EPS);
        }
      });

      it("the address is never silently clipped", () => {
        const m = get();
        if (!m.address) return;
        expect(m.address.box.bottom).toBeLessThanOrEqual(m.top.bottom + EPS);
        if (m.address.scrollHeight > m.address.clientHeight + 1) {
          // Clamped by CSS: only acceptable alongside the visible marker.
          expect(m.addressTruncated).not.toBeNull();
        }
      });

      it("a COD amount is visible and nothing covers it", () => {
        const m = get();
        if (!m.codAmount) return;
        expect(inside(m.codAmount, m.payment)).toBe(true);
        expect(m.codAmountOnTop).toBe(true);
        // No item line, address or upper section shares any area with the
        // amount — painting order alone must never be what keeps it legible.
        const others = [...m.itemLines, ...m.receiverSections, m.itemsSection];
        if (m.moreItems) others.push(m.moreItems);
        if (m.address) others.push(m.address.box);
        for (const other of others) {
          expect(intersects(other, m.codAmount)).toBe(false);
        }
      });
    });
  }

  it("long addresses carry the visible continuation marker", () => {
    for (const id of [
      "km-address-500",
      "en-address-500",
      "km-address-max",
      "en-address-max-paid",
    ]) {
      const m = measured.find((x) => x.id === id)!;
      expect(m.addressTruncated).not.toBeNull();
      expect(m.addressTruncated!.bottom).toBeLessThanOrEqual(m.top.bottom + EPS);
    }
  });

  it("8+ item orders show '+N more' instead of overflowing", () => {
    for (const id of ["km-address-500", "km-address-max", "many-items-no-carrier"]) {
      const m = measured.find((x) => x.id === id)!;
      expect(m.moreItems).not.toBeNull();
    }
  });
});
