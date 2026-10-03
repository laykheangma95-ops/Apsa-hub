/**
 * Parcel label — permission revocation and nested-focus regressions, in a real
 * browser against the real <ParcelLabelDialog>.
 *
 * 1. PII fail-closed. With the dialog OPEN and showing the recipient's name,
 *    phone and address (and the Edit sheet holding them in form fields),
 *    `fulfillment.print_label` is revoked. Every trace must leave the page at
 *    once — text, input values, the Print action — and reopening must stay
 *    denied without a fetch, then refetch afresh once the capability returns.
 * 2. One focus trap at a time. The label overlay and the child shipping sheet
 *    both trap focus; only one may be live. Tab / Shift+Tab stay inside the
 *    child, Escape closes ONLY the child, the label dialog is usable again, and
 *    closing it returns focus to its trigger.
 *
 * Capabilities flow through the REAL <CapabilityProvider> and its production
 * query; revocation is a change in the in-page fake SERVER (never a React prop),
 * which the client discovers by polling / print-time re-authorization. Only
 * `@/lib/api` and `@/api/capabilities` are aliased — see fixtures/. Skips loudly when no
 * Chromium exists.
 *
 * Run: bun test src/tests/parcel-label-revocation.browser.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import km from "@/locales/km.json";

// ── Browser discovery ─────────────────────────────────────────────────────────

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
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const BROWSER = findBrowser();
if (!BROWSER) {
  console.warn(
    "[parcel-label-revocation.browser] SKIPPED — no Chromium/Chrome binary found. " +
      "Set APSA_CHROME_PATH to run the real-browser parcel-label regressions.",
  );
}

const T = {
  edit: km.labels.parcel.editCta,
  print: km.labels.print,
  close: km.common.close,
  denied: km.labels.parcel.denied,
};
const PII = ["Sokha Chan", "+855 12 345 678", "Toul Tompoung"];

// ── CDP session ───────────────────────────────────────────────────────────────

interface Session {
  evaluate<T>(expression: string): Promise<T>;
  /** Wait until an expression evaluates truthy, else throw with `label`. */
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  key(name: "Escape" | "Tab", shiftKey?: boolean): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  /** Ctrl+P as real key input (the browser's print shortcut). */
  printShortcut(): Promise<void>;
  /**
   * A NATIVE browser print of the page as it is right now (CDP
   * Page.printToPDF — the same print pipeline as the browser's Print menu,
   * with real beforeprint / afterprint events and print media). Returns the
   * text that was laid out for the printer and the PDF's page count.
   */
  nativePrint(): Promise<{ text: string; pages: number; events: string[] }>;
  /**
   * The text laid out under print media right now, WITHOUT starting a print
   * (no beforeprint / afterprint): what a print already in progress renders.
   */
  printMediaText(): Promise<string>;
}

function tailDrain(stream: ReadableStream<Uint8Array> | null, maxChars: number): () => string {
  let buffered = "";
  if (!stream) return () => buffered;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buffered = (buffered + decoder.decode(chunk, { stream: true })).slice(-maxChars);
    }
  })().catch(() => {});
  return () => buffered;
}

async function waitForDevToolsEndpoint(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<string> {
  let buffered = "";
  const stderr = child.stderr instanceof ReadableStream ? child.stderr : null;
  if (!stderr) throw new Error("Chromium stderr was not piped");

  const announcement = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stderr as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      const match = buffered.match(/ws:\/\/[^\s]+/);
      if (match) return match[0];
    }
    throw new Error("Chromium exited before announcing a DevTools endpoint");
  })();

  const exited = child.exited.then(async (code) => {
    throw new Error(`Chromium exited early with code ${code}`);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for a DevTools endpoint`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([announcement, exited, timedOut]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nLast stderr:\n${buffered.slice(-4000) || "(empty)"}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bound an awaited step. A hung Chromium/DevTools handshake used to stall
 * `beforeAll` for its whole 120s budget with no diagnostics (seen once on a
 * loaded CI runner); every step that waits on the browser now fails fast with
 * its own name so the session can be retried on a fresh browser.
 */
function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Start a session, retrying once on a brand-new browser if the handshake hangs. */
async function startSession(browser: string): Promise<Session> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await startSessionOnce(browser);
    } catch (error) {
      lastError = error;
      console.warn(`[parcel-label-revocation.browser] session attempt ${attempt} failed: ${error}`);
    }
  }
  throw lastError;
}

async function startSessionOnce(browser: string): Promise<Session> {
  /*
   * `@/lib/api` is redirected to the fixture stub for THIS bundle only. The
   * alias lives here rather than in the fixture's own imports so the fixture
   * keeps importing the component exactly as the app does — nothing in
   * src/components is aware a test is running, and no production build can
   * reach the stub.
   */
  const apiStub = path.resolve("src/tests/fixtures/parcel-label-api-stub.ts");
  const capabilitiesStub = path.resolve("src/tests/fixtures/parcel-label-capabilities-stub.ts");
  const build = await Bun.build({
    entrypoints: [path.resolve("src/tests/fixtures/parcel-label-revocation-page.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [
      {
        name: "apsa-api-stub",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/api$/ }, () => ({ path: apiStub }));
          // The server function behind the REAL capability query resolves to an
          // in-page fake server whose grant the tests revoke/restore.
          builder.onResolve({ filter: /^@\/api\/capabilities$/ }, () => ({
            path: capabilitiesStub,
          }));
        },
      },
    ],
  });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const js = await build.outputs[0]!.text();
  const html =
    '<!doctype html><meta charset="utf-8"><title>parcel label revocation fixture</title>' +
    '<body><div id="root"></div><script type="module" src="/app.js"></script>';

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const isScript = new URL(request.url).pathname === "/app.js";
      return new Response(isScript ? js : html, {
        headers: { "content-type": isScript ? "text/javascript" : "text/html" },
      });
    },
  });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apsa-parcel-label-"));
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
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdoutTail = tailDrain(child.stdout instanceof ReadableStream ? child.stdout : null, 4000);

  let endpoint: string;
  try {
    const wsUrl = await waitForDevToolsEndpoint(child, 20_000);
    endpoint = `http://${new URL(wsUrl.replace(/^ws:/, "http:")).host}`;
  } catch (error) {
    child.kill();
    await child.exited;
    server.stop(true);
    fs.rmSync(profile, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Chromium failed to start (executable: ${browser}).\n${reason}\nLast stdout:\n${stdoutTail() || "(empty)"}`,
    );
  }

  /*
   * Create the page target rather than listing existing ones. A
   * `--headless=new` launch with no URL argument is not guaranteed to have a
   * page target yet, so `/json/list` found none on the GitHub runner and the
   * whole suite failed before it opened a sheet. `/json/new` is the approach
   * bottom-sheet-focus-trap.browser.ts already proves on this CI.
   */
  const teardown = async () => {
    child.kill();
    await child.exited;
    server.stop(true);
    fs.rmSync(profile, { recursive: true, force: true });
  };
  let socket!: WebSocket;
  try {
    const pageTarget = (await within(
      "create page target",
      10_000,
      fetch(`${endpoint}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json()),
    )) as { webSocketDebuggerUrl?: string };
    if (!pageTarget?.webSocketDebuggerUrl) throw new Error("no page target");

    socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await within(
      "open CDP socket",
      10_000,
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("CDP socket failed")), {
          once: true,
        });
      }),
    );
  } catch (error) {
    await teardown();
    throw error;
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.error) slot.reject(new Error(message.error.message));
    else slot.resolve(message.result);
  });

  function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = nextId++;
    return within(
      `CDP ${method}`,
      15_000,
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    );
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const result = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async function key(name: "Escape" | "Tab", shiftKey = false): Promise<void> {
    const common = {
      key: name,
      code: name,
      windowsVirtualKeyCode: name === "Escape" ? 27 : 9,
      nativeVirtualKeyCode: name === "Escape" ? 27 : 9,
      modifiers: shiftKey ? 8 : 0,
    };
    await send("Input.dispatchKeyEvent", { ...common, type: "rawKeyDown" });
    await send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
    await Bun.sleep(60);
  }

  async function waitFor(expression: string, label: string, timeoutMs = 5000): Promise<void> {
    for (let attempt = 0; attempt < timeoutMs / 25; attempt++) {
      await Bun.sleep(25);
      if (await evaluate<boolean>(`!!(${expression})`)) return;
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: server.url.origin });
    // The page must be the foreground one, or Chromium delivers no focus events
    // and every containment assertion below silently stops covering anything.
    await send("Page.bringToFront");
    await waitFor("document.getElementById('trigger')", "fixture mount");
  } catch (error) {
    socket.close();
    await teardown();
    throw error;
  }

  async function printShortcut(): Promise<void> {
    const common = {
      key: "p",
      code: "KeyP",
      windowsVirtualKeyCode: 80,
      nativeVirtualKeyCode: 80,
      modifiers: 2, // Ctrl
    };
    await send("Input.dispatchKeyEvent", { ...common, type: "rawKeyDown" });
    await send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
    await Bun.sleep(60);
  }

  async function nativePrint(): Promise<{ text: string; pages: number; events: string[] }> {
    // Record what the print pipeline itself sees: the print events, and the
    // page's rendered text at the moment print media becomes active.
    await evaluate(`(() => {
      const w = window;
      w.__nativePrint = { events: [], text: null };
      if (w.__nativePrintInstalled) return true;
      w.__nativePrintInstalled = true;
      w.addEventListener('beforeprint', () => w.__nativePrint.events.push('beforeprint'));
      w.addEventListener('afterprint', () => w.__nativePrint.events.push('afterprint'));
      w.matchMedia('print').addEventListener('change', (e) => {
        if (e.matches) w.__nativePrint.text = document.body.innerText;
      });
      return true;
    })()`);
    const pdf = (await send("Page.printToPDF", { preferCSSPageSize: true })) as { data: string };
    const raw = Buffer.from(pdf.data, "base64").toString("latin1");
    const pages = (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    const seen = await evaluate<{ events: string[]; text: string | null }>("window.__nativePrint");
    if (seen.text === null) throw new Error("print media never became active during the print");
    await Bun.sleep(60);
    return { text: seen.text.trim(), pages, events: seen.events };
  }

  async function printMediaText(): Promise<string> {
    await send("Emulation.setEmulatedMedia", { media: "print" });
    try {
      return (await evaluate<string>("document.body.innerText")).trim();
    } finally {
      await send("Emulation.setEmulatedMedia", { media: "" });
    }
  }

  return {
    evaluate,
    waitFor,
    key,
    printShortcut,
    nativePrint,
    printMediaText,
    async reload() {
      await send("Page.navigate", { url: server.url.origin });
      await send("Page.bringToFront");
      await waitFor("document.getElementById('trigger')", "fixture remount");
    },
    async close() {
      socket.close();
      child.kill();
      await child.exited;
      server.stop(true);
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

// ── Page helpers ──────────────────────────────────────────────────────────────

const click = (id: string) =>
  `(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.click(); return true; })()`;
const clickByText = (label: string) => `(() => {
  const target = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!target) throw new Error('no button: ' + ${JSON.stringify(label)});
  target.focus();
  target.click();
  return true;
})()`;
const hasButton = (label: string) =>
  `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const DIALOGS = "document.querySelectorAll('[role=\"dialog\"]').length";
/** Everything a denied user could read: text AND every form control's value. */
const VISIBLE_PII_DUMP = `(() => {
  const fields = [...document.querySelectorAll('input,textarea')].map((e) => e.value).join('|');
  return document.body.textContent + '|' + fields + '|' + document.body.innerHTML;
})()`;
const ACTIVE_IN = (selector: string) =>
  `(() => { const d = document.querySelector(${JSON.stringify(selector)}); return !!d && d.contains(document.activeElement); })()`;
/** The child sheet is the dialog that holds the shipping form. */
const CHILD = '[role="dialog"]:has(textarea)';
const LABEL = '[role="dialog"]:not(:has(textarea))';

const test60 = (name: string, fn: () => Promise<void>) => it(name, fn, 60000);
const test90 = (name: string, fn: () => Promise<void>) => it(name, fn, 90000);

const describeBrowser = BROWSER ? describe : describe.skip;

describeBrowser("parcel label dialog, real Chromium", () => {
  let page: Session;
  beforeAll(async () => {
    page = await startSession(BROWSER!);
  }, 200000);
  afterAll(async () => {
    await page?.close();
  });

  async function openLabel() {
    await page.evaluate(click("trigger"));
    await page.waitFor(hasButton(T.print), "label dialog with a Print action");
  }

  // Revalidation cadence is 15s; allow one full tick plus margin.
  const POLL_WAIT = 25_000;
  const REVOKE = "window.apsaServer.revoke()";
  const GRANT = "window.apsaServer.grant()";
  const EDIT_OPEN = "document.querySelector('textarea')";

  test90(
    "A. a SERVER-side revocation reaches the open label (no manual prop swap) and clears every trace of PII",
    async () => {
      await page.reload();
      await openLabel();
      const before = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(before).toContain(value);

      // Open the correction sheet: the PII is now also in form-field values.
      await page.evaluate(clickByText(T.edit));
      await page.waitFor(EDIT_OPEN, "shipping sheet");
      const inFields = await page.evaluate<string>(
        "[...document.querySelectorAll('input,textarea')].map((e) => e.value).join('|')",
      );
      for (const value of PII) expect(inFields).toContain(value);

      // Only the "server" changes. The client must notice on its own.
      const requestsBefore = await page.evaluate<number>("window.apsaServer.capabilityRequests");
      await page.evaluate(REVOKE);
      await page.waitFor(`!${hasButton(T.print)}`, "poll to observe the revocation", POLL_WAIT);
      expect(await page.evaluate<number>("window.apsaServer.capabilityRequests")).toBeGreaterThan(
        requestsBefore,
      );
      await Bun.sleep(400);

      const after = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(after).not.toContain(value);
      // The child sheet is gone; only the (now denied) label overlay remains.
      expect(await page.evaluate<number>(DIALOGS)).toBe(1);
      expect(await page.evaluate<boolean>("!document.querySelector('textarea,input')")).toBe(true);
      expect(await page.evaluate<boolean>(hasButton(T.print))).toBe(false);
      expect(await page.evaluate<boolean>(hasButton(T.edit))).toBe(false);
      expect(
        await page.evaluate<boolean>(
          `document.body.textContent.includes(${JSON.stringify(T.denied)})`,
        ),
      ).toBe(true);
      // Print DOM: nothing sensitive remains in the print root either.
      expect(
        await page.evaluate<string>(
          "(document.getElementById('apsa-print-root') || document.body).textContent",
        ),
      ).not.toContain("Sokha");
    },
  );

  test90(
    "B. reopening stays denied with no fetch, then a re-grant is detected and the label is fetched afresh",
    async () => {
      // Still revoked (server-side) from A. Close, then reopen.
      await page.key("Escape");
      await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
      const fetchesBefore = await page.evaluate<number>("window.apsaServer.labelFetches.length");
      await page.evaluate(click("trigger"));
      await page.waitFor(`${DIALOGS} === 1`, "denied dialog");
      await Bun.sleep(400);
      const dump = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(dump).not.toContain(value);
      expect(await page.evaluate<boolean>(hasButton(T.print))).toBe(false);
      expect(await page.evaluate<number>("window.apsaServer.labelFetches.length")).toBe(
        fetchesBefore,
      );

      // Restore the grant on the server only. The open (denied) dialog must
      // notice by itself, and must fetch the label anew — never resurrect data.
      await page.evaluate(GRANT);
      await page.waitFor(hasButton(T.print), "Print action after re-grant", POLL_WAIT);
      expect(await page.evaluate<number>("window.apsaServer.labelFetches.length")).toBe(
        fetchesBefore + 1,
      );
      await page.key("Escape");
      await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
    },
  );

  test90(
    "D. print-time re-authorization: revoked immediately before Print → server check denies, window.print() NOT called, PII cleared",
    async () => {
      await page.reload();
      await openLabel();
      const printsBefore = await page.evaluate<number>("window.apsaServer.printCalls");

      // Sanity: an authorized Print does reach window.print() after a fresh check.
      const checksBefore = await page.evaluate<number>("window.apsaServer.capabilityRequests");
      await page.evaluate(clickByText(T.print));
      await page.waitFor(
        `window.apsaServer.printCalls === ${printsBefore + 1}`,
        "authorized print",
      );
      expect(await page.evaluate<number>("window.apsaServer.capabilityRequests")).toBeGreaterThan(
        checksBefore,
      );

      // Now revoke and click Print in the SAME tick: the cached client view still
      // says "granted" (no poll can have run), so only the fresh check can stop it.
      await page.evaluate(
        `(() => { ${REVOKE}; const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(T.print)}); b.click(); return true; })()`,
      );
      await page.waitFor(`!${hasButton(T.print)}`, "denied state after failed re-authorization");
      await Bun.sleep(300);
      expect(await page.evaluate<number>("window.apsaServer.printCalls")).toBe(printsBefore + 1);
      const dump = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(dump).not.toContain(value);
      await page.evaluate(GRANT);
    },
  );

  test90(
    "E. if the fresh authorization request FAILS, printing is refused and PII is cleared",
    async () => {
      await page.reload();
      await openLabel();
      const printsBefore = await page.evaluate<number>("window.apsaServer.printCalls");
      await page.evaluate("window.apsaServer.capabilityFails = true");
      await page.evaluate(clickByText(T.print));
      await page.waitFor(`!${hasButton(T.print)}`, "denied state after failed check");
      await Bun.sleep(300);
      expect(await page.evaluate<number>("window.apsaServer.printCalls")).toBe(printsBefore);
      const dump = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(dump).not.toContain(value);
      await page.evaluate("window.apsaServer.capabilityFails = false");
      await page.key("Escape");
      await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
    },
  );

  test90(
    "F. a snapshotless order shows NO inferred recipient: the confirmation form is empty",
    async () => {
      await page.reload();
      await page.evaluate("window.apsaServer.snapshotless = true");
      await page.evaluate(click("trigger"));
      // No printable label; the confirm action is offered instead.
      await page.waitFor(hasButton(km.labels.parcel.confirmCta), "confirm action");
      expect(await page.evaluate<boolean>(hasButton(T.print))).toBe(false);
      await page.evaluate(clickByText(km.labels.parcel.confirmCta));
      await page.waitFor(EDIT_OPEN, "shipping sheet");
      const fields = await page.evaluate<string>(
        "[...document.querySelectorAll('input,textarea')].map((e) => e.value).join('')",
      );
      expect(fields).toBe("");
      const dump = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(dump).not.toContain(value);
      await page.evaluate("window.apsaServer.snapshotless = false");
    },
  );

  // ── Native browser print (Ctrl/Cmd+P, the browser's Print menu) ─────────────
  //
  // The preview is not printable. Only the temporary print target, generated
  // after a successful server validation and destroyed after one print, ever
  // reaches the printer.

  const PRINT_ROOT = "document.getElementById('apsa-print-root')";
  const TRACKING = (n: string) => `VET-${n}`;
  const NOTICE = km.labels.parcel.printNotice;
  const hasText = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;
  const counts = () =>
    page.evaluate<{ prints: number; fetches: number; checks: number }>(
      "({ prints: window.apsaServer.printCalls, fetches: window.apsaServer.labelFetches.length, checks: window.apsaServer.capabilityRequests })",
    );

  /** Nothing of the label — and nothing at all — went to the printer. */
  async function expectNativePrintIsEmpty() {
    const printed = await page.nativePrint();
    expect(printed.events).toContain("beforeprint");
    expect(printed.text).toBe("");
    for (const value of [...PII, TRACKING("1"), TRACKING("2")]) {
      expect(printed.text).not.toContain(value);
    }
    expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
  }

  async function openFreshLabel() {
    await page.reload();
    await openLabel();
    // The preview IS on screen with the recipient and tracking number…
    const screen = await page.evaluate<string>("document.body.innerText");
    for (const value of [...PII, TRACKING("1")]) expect(screen).toContain(value);
    // …and no print target exists until a print is authorized.
    expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
  }

  test90(
    "G. native browser print BEFORE authorization prints nothing; Ctrl+P takes the guarded path",
    async () => {
      await openFreshLabel();
      const before = await counts();

      // Browser menu Print, with the label preview open and never validated.
      await expectNativePrintIsEmpty();
      const afterNative = await counts();
      expect(afterNative.prints).toBe(before.prints);

      // Ctrl+P is not the browser's print of this page: it is the same guarded
      // path as the Print button — fresh read, re-authorization, then print.
      expect(
        await page.evaluate<boolean>(
          "(() => { const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true, repeat: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })()",
        ),
      ).toBe(true);
      expect(
        await page.evaluate<boolean>(
          "(() => { const e = new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true, repeat: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })()",
        ),
      ).toBe(true);
      await page.printShortcut();
      await page.waitFor(
        `window.apsaServer.printCalls === ${before.prints + 1}`,
        "guarded print from Ctrl+P",
      );
      const afterShortcut = await counts();
      expect(afterShortcut.fetches).toBeGreaterThan(afterNative.fetches);
      expect(afterShortcut.checks).toBeGreaterThan(afterNative.checks);

      // That guarded print found the validated target — the label — and the
      // target was destroyed with it: the next native print is empty again.
      const printedByGuard = await page.evaluate<string>("window.apsaServer.printed.at(-1)");
      for (const value of [...PII, TRACKING("1")]) expect(printedByGuard).toContain(value);
      await page.waitFor(`!${PRINT_ROOT}`, "print target destroyed after printing");
      await expectNativePrintIsEmpty();
      expect((await counts()).prints).toBe(before.prints + 1);
    },
  );

  test90(
    "H. native browser print after permission revocation prints nothing (and so does Print)",
    async () => {
      await openFreshLabel();
      const before = await counts();
      // Revoked on the server; the client has not polled yet, so the preview
      // (with PII) is still on screen — and must not be printable.
      await page.evaluate(REVOKE);
      expect(await page.evaluate<boolean>(hasText(PII[0]!))).toBe(true);
      await expectNativePrintIsEmpty();

      await page.evaluate(clickByText(T.print));
      await page.waitFor(`!${hasButton(T.print)}`, "denied after re-authorization");
      await Bun.sleep(300);
      expect((await counts()).prints).toBe(before.prints);
      await expectNativePrintIsEmpty();

      // Ctrl+P on the denied dialog starts nothing either.
      await page.printShortcut();
      await Bun.sleep(300);
      expect((await counts()).prints).toBe(before.prints);
      await expectNativePrintIsEmpty();
      await page.evaluate(GRANT);
    },
  );

  test90(
    "I. native browser print after order cancellation prints nothing (and so does Print)",
    async () => {
      await openFreshLabel();
      const before = await counts();
      // Cancelled on the server; the stale preview is still on screen.
      await page.evaluate("window.apsaServer.orderCancelled = true");
      await expectNativePrintIsEmpty();

      await page.evaluate(clickByText(T.print));
      await page.waitFor(hasText(NOTICE.refreshFailed), "refused pre-print refresh");
      expect((await counts()).fetches).toBeGreaterThan(before.fetches);
      expect((await counts()).prints).toBe(before.prints);
      await expectNativePrintIsEmpty();
      await page.evaluate("window.apsaServer.orderCancelled = false");
    },
  );

  test90(
    "J. native browser print after shipment replacement prints only refreshed data",
    async () => {
      await openFreshLabel();
      const before = await counts();
      // The shipment is replaced on the server: new id, new tracking number.
      await page.evaluate(
        "window.apsaServer.shipment = { id: 'shipment-2', trackingNumber: 'VET-2' }",
      );
      // The preview still shows the OLD shipment; a native print outputs nothing.
      expect(await page.evaluate<boolean>(hasText(TRACKING("1")))).toBe(true);
      await expectNativePrintIsEmpty();

      // Print: the fresh read differs → nothing printed, the preview is refreshed.
      await page.evaluate(clickByText(T.print));
      await page.waitFor(hasText(NOTICE.changed), "changed notice");
      await page.waitFor(hasText(TRACKING("2")), "preview refreshed to the new shipment");
      expect((await counts()).prints).toBe(before.prints);
      await expectNativePrintIsEmpty();

      // Print again after review: validated → the target holds ONLY fresh data,
      // and is destroyed with that print.
      await page.evaluate(clickByText(T.print));
      await page.waitFor(
        `window.apsaServer.printCalls === ${before.prints + 1}`,
        "validated print of the replacement shipment",
      );
      const printedByGuard = await page.evaluate<string>("window.apsaServer.printed.at(-1)");
      expect(printedByGuard).toContain(TRACKING("2"));
      expect(printedByGuard).not.toContain(TRACKING("1"));
      await page.waitFor(`!${PRINT_ROOT}`, "print target destroyed after printing");
      await expectNativePrintIsEmpty();

      // A replacement after that print can never come out of a stale target.
      await page.evaluate(
        "window.apsaServer.shipment = { id: 'shipment-3', trackingNumber: 'VET-3' }",
      );
      await expectNativePrintIsEmpty();
      await page.evaluate(
        "window.apsaServer.shipment = { id: 'shipment-1', trackingNumber: 'VET-1' }",
      );
    },
  );

  test90("K. a failed pre-print refresh prints nothing", async () => {
    await openFreshLabel();
    const before = await counts();
    await page.evaluate("window.apsaServer.labelFails = true");
    await page.evaluate(clickByText(T.print));
    await page.waitFor(hasText(NOTICE.refreshFailed), "refresh-failed notice");
    await Bun.sleep(200);
    expect((await counts()).prints).toBe(before.prints);
    await expectNativePrintIsEmpty();

    // Ctrl+P fails closed the same way.
    await page.printShortcut();
    await Bun.sleep(400);
    expect((await counts()).prints).toBe(before.prints);
    await expectNativePrintIsEmpty();
    await page.evaluate("window.apsaServer.labelFails = false");
    await page.key("Escape");
    await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
  });

  test60("L. closing the dialog destroys a print target that was never printed", async () => {
    await openFreshLabel();
    const before = await counts();
    // A print still in progress when the dialog is closed (never completed).
    await page.evaluate("window.apsaServer.asyncPrint = true");
    await page.evaluate(clickByText(T.print));
    await page.waitFor(`window.apsaServer.printCalls === ${before.prints + 1}`, "guarded print");
    await page.waitFor(PRINT_ROOT, "temporary print target");
    await page.evaluate(
      `(() => { const b = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(T.close)}); b.click(); return true; })()`,
    );
    await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
    expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
    await page.evaluate("window.apsaServer.asyncPrint = false");
    // With the dialog closed the page prints as the ordinary app page — and
    // nothing of the label is on it.
    const printed = await page.nativePrint();
    for (const value of [...PII, TRACKING("1")]) expect(printed.text).not.toContain(value);
    const dump = await page.evaluate<string>(VISIBLE_PII_DUMP);
    for (const value of PII) expect(dump).not.toContain(value);
  });

  // ── Print target lifecycle: one target, one print ───────────────────────────
  //
  // A target never survives the print it was generated for — synchronous or
  // asynchronous — and cleanup needs no pointer, focus, key or timer. These
  // tests never touch the page between prints except to start one.

  const PRINTED = "window.apsaServer.printed";
  const printedCount = () => page.evaluate<number>(`${PRINTED}.length`);
  const SET_SHIPMENT = (n: string) =>
    `window.apsaServer.shipment = { id: 'shipment-${n}', trackingNumber: 'VET-${n}' }`;
  const RESET_SERVER = `(() => {
    const s = window.apsaServer;
    s.asyncPrint = false;
    s.shipment = { id: 'shipment-1', trackingNumber: 'VET-1' };
    s.payment = { state: 'paid', paid: true, collect: null, partial: false, checkReason: null };
    s.grant();
    return true;
  })()`;

  /** One guarded, completed (synchronous) print of the label on screen. */
  async function printOnce(label: string) {
    const before = await counts();
    await page.evaluate(clickByText(T.print));
    await page.waitFor(`window.apsaServer.printCalls === ${before.prints + 1}`, label);
    await page.waitFor(`!${PRINT_ROOT}`, `${label}: target destroyed with its print`);
    return before;
  }

  test90(
    "M. asynchronous print completion: the target dies with the print, with no page interaction",
    async () => {
      await openFreshLabel();
      await page.evaluate("window.apsaServer.asyncPrint = true");
      const before = await counts();
      await page.evaluate(clickByText(T.print));
      await page.waitFor(`window.apsaServer.printCalls === ${before.prints + 1}`, "async print");

      // window.print() has returned; the print is still in progress and renders
      // the validated target — exactly the label, nothing else.
      expect(await page.evaluate<boolean>(`!!${PRINT_ROOT}`)).toBe(true);
      const inProgress = await page.printMediaText();
      for (const value of [...PII, TRACKING("1")]) expect(inProgress).toContain(value);
      expect(inProgress).not.toContain(T.print);

      // The print completes on its own. No pointer, focus, key or timer.
      await page.evaluate("window.apsaServer.completePrint()");
      expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
      expect(await page.printMediaText()).toBe("");

      // A browser-menu Print right after: nothing, and again: nothing.
      await expectNativePrintIsEmpty();
      await expectNativePrintIsEmpty();
      expect((await counts()).prints).toBe(before.prints + 1);
      await page.evaluate(RESET_SERVER);
    },
  );

  test90(
    "N. a browser-menu Print DURING an asynchronous print cannot reuse its target",
    async () => {
      await openFreshLabel();
      await page.evaluate("window.apsaServer.asyncPrint = true");
      const before = await counts();
      await page.evaluate(clickByText(T.print));
      await page.waitFor(`window.apsaServer.printCalls === ${before.prints + 1}`, "async print");
      expect(await page.evaluate<boolean>(`!!${PRINT_ROOT}`)).toBe(true);

      // The first print has not completed. A second, native print begins: the
      // target is destroyed before layout, so it outputs nothing.
      await expectNativePrintIsEmpty();
      await expectNativePrintIsEmpty();
      await page.evaluate("window.apsaServer.completePrint()");
      await expectNativePrintIsEmpty();
      expect((await counts()).prints).toBe(before.prints + 1);
      await page.evaluate(RESET_SERVER);
    },
  );

  test90("O. a window.print() that begins no print leaves no target behind", async () => {
    await openFreshLabel();
    const before = await counts();
    // The browser ignores the call entirely: no beforeprint, no afterprint.
    await page.evaluate(
      "(() => { window.__realStubPrint = window.print; window.print = () => { window.apsaServer.printCalls += 1; }; return true; })()",
    );
    await page.evaluate(clickByText(T.print));
    await page.waitFor(`window.apsaServer.printCalls === ${before.prints + 1}`, "ignored print");
    expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
    await expectNativePrintIsEmpty();
    await page.evaluate("(() => { window.print = window.__realStubPrint; return true; })()");
  });

  test90(
    "P. permission revoked after the first print: a repeat print outputs nothing",
    async () => {
      await openFreshLabel();
      const before = await printOnce("first print");
      expect(await page.evaluate<string>(`${PRINTED}.at(-1)`)).toContain(PII[0]!);
      const printedBefore = await printedCount();

      await page.evaluate(REVOKE);
      // Browser-menu Print at once, twice, with no interaction in between.
      await expectNativePrintIsEmpty();
      await expectNativePrintIsEmpty();
      // Ctrl+P: a new authorization is required — and refused.
      await page.printShortcut();
      await page.waitFor(`!${hasButton(T.print)}`, "denied after re-authorization");
      await Bun.sleep(300);
      expect((await counts()).prints).toBe(before.prints + 1);
      expect(await printedCount()).toBe(printedBefore);
      await expectNativePrintIsEmpty();
      await page.evaluate(RESET_SERVER);
    },
  );

  test90(
    "Q. shipment replaced after the first print: a repeat print never outputs the old shipment",
    async () => {
      await openFreshLabel();
      const before = await printOnce("first print");
      expect(await page.evaluate<string>(`${PRINTED}.at(-1)`)).toContain(TRACKING("1"));
      const printedBefore = await printedCount();

      await page.evaluate(SET_SHIPMENT("2"));
      await expectNativePrintIsEmpty();
      await expectNativePrintIsEmpty();
      // Ctrl+P: fresh validation sees the replacement → review, nothing printed.
      await page.printShortcut();
      await page.waitFor(hasText(NOTICE.changed), "changed notice");
      expect((await counts()).prints).toBe(before.prints + 1);
      expect(await printedCount()).toBe(printedBefore);
      await expectNativePrintIsEmpty();

      // After review, a NEW authorization prints only the replacement.
      await printOnce("print of the replacement");
      const reprinted = await page.evaluate<string>(`${PRINTED}.at(-1)`);
      expect(reprinted).toContain(TRACKING("2"));
      expect(reprinted).not.toContain(TRACKING("1"));
      await expectNativePrintIsEmpty();
      await page.evaluate(RESET_SERVER);
    },
  );

  test90(
    "R. payment / COD changed after the first print: a repeat print never outputs the old payment",
    async () => {
      await openFreshLabel();
      const before = await printOnce("first print (PAID)");
      const firstPrint = await page.evaluate<string>(`${PRINTED}.at(-1)`);
      const printedBefore = await printedCount();

      // PAID → COD on the server.
      await page.evaluate(
        "window.apsaServer.payment = { state: 'cod', paid: false, collect: { amount: 1500, currency: 'USD' }, partial: false, checkReason: null }",
      );
      await expectNativePrintIsEmpty();
      await expectNativePrintIsEmpty();
      await page.evaluate(clickByText(T.print));
      await page.waitFor(hasText(NOTICE.changed), "changed notice (payment)");
      expect((await counts()).prints).toBe(before.prints + 1);
      expect(await printedCount()).toBe(printedBefore);
      await expectNativePrintIsEmpty();

      // The COD amount changes again before the reviewed print: refused again.
      await page.evaluate(
        "window.apsaServer.payment = { state: 'cod', paid: false, collect: { amount: 1999, currency: 'USD' }, partial: false, checkReason: null }",
      );
      await page.evaluate(clickByText(T.print));
      await Bun.sleep(400);
      expect((await counts()).prints).toBe(before.prints + 1);
      await expectNativePrintIsEmpty();

      // A NEW authorization prints the current payment, not the first print's.
      await printOnce("print of the current payment");
      expect(await page.evaluate<string>(`${PRINTED}.at(-1)`)).not.toBe(firstPrint);
      await expectNativePrintIsEmpty();
      await page.evaluate(RESET_SERVER);
    },
  );

  test90(
    "S. Ctrl+P immediately repeated: every print is a new authorization and a fresh read",
    async () => {
      await openFreshLabel();
      const before = await counts();
      const printedBefore = await printedCount();

      for (let n = 1; n <= 3; n++) {
        const start = await counts();
        await page.printShortcut();
        await page.waitFor(
          `window.apsaServer.printCalls === ${before.prints + n}`,
          `guarded print ${n} from Ctrl+P`,
        );
        const end = await counts();
        // Its own fresh server read and its own re-authorization, every time.
        expect(end.fetches).toBeGreaterThan(start.fetches);
        expect(end.checks).toBeGreaterThan(start.checks);
        // Its own target, generated for this print and destroyed with it.
        expect(await printedCount()).toBe(printedBefore + n);
        expect(await page.evaluate<string>(`${PRINTED}.at(-1)`)).toContain(TRACKING("1"));
        expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
      }

      // A second Ctrl+P while the first is still validating starts no second
      // print and reuses nothing: exactly one print results.
      const start = await counts();
      await page.evaluate(
        "(() => { for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()",
      );
      await page.waitFor(`window.apsaServer.printCalls === ${start.prints + 1}`, "one print");
      await Bun.sleep(400);
      expect((await counts()).prints).toBe(start.prints + 1);
      expect(await page.evaluate<boolean>(`!${PRINT_ROOT}`)).toBe(true);
      await expectNativePrintIsEmpty();
      await page.key("Escape");
      await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
    },
  );

  test60("C. only ONE focus trap is live: Tab / Shift+Tab / Escape / focus return", async () => {
    await page.reload();
    await openLabel();
    expect(await page.evaluate<boolean>(ACTIVE_IN(LABEL))).toBe(true);

    await page.evaluate(clickByText(T.edit));
    await page.waitFor("document.querySelector('textarea')", "shipping sheet");
    await Bun.sleep(400);
    // The child owns focus, and keeps it through a full Tab and Shift+Tab loop.
    for (let i = 0; i < 8; i++) {
      await page.key("Tab");
      expect(await page.evaluate<boolean>(ACTIVE_IN(CHILD))).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await page.key("Tab", true);
      expect(await page.evaluate<boolean>(ACTIVE_IN(CHILD))).toBe(true);
    }
    // The stood-down label overlay is no longer an honest aria-modal.
    expect(
      await page.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(LABEL)}).getAttribute('aria-modal') === null`,
      ),
    ).toBe(true);

    // Escape closes ONLY the child.
    await page.key("Escape");
    await page.waitFor(`!document.querySelector('textarea')`, "child closed");
    expect(await page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(LABEL)})`)).toBe(
      true,
    );
    expect(await page.evaluate<boolean>(ACTIVE_IN(LABEL))).toBe(true);
    expect(
      await page.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(LABEL)}).getAttribute('aria-modal') === 'true'`,
      ),
    ).toBe(true);

    // The label trap works again: Tab stays inside it.
    for (let i = 0; i < 6; i++) {
      await page.key("Tab");
      expect(await page.evaluate<boolean>(ACTIVE_IN(LABEL))).toBe(true);
    }
    // The close button closes it and focus returns to the trigger.
    await page.evaluate(
      `(() => { const b = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(T.close)}); b.focus(); b.click(); return true; })()`,
    );
    await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
    expect(await page.evaluate<string>("document.activeElement.id")).toBe("trigger");
  });
});
