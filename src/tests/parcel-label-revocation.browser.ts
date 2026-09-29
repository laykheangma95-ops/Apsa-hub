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
 * Only `@/lib/api` (and the server-function import of use-capabilities) is
 * aliased away — see fixtures/parcel-label-api-stub.ts. Skips loudly when no
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
  waitFor(expression: string, label: string): Promise<void>;
  key(name: "Escape" | "Tab", shiftKey?: boolean): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
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
  const capabilitiesStub = path.resolve(
    "src/tests/fixtures/pos-payment-stacking-capabilities-stub.ts",
  );
  const build = await Bun.build({
    entrypoints: [path.resolve("src/tests/fixtures/parcel-label-revocation-page.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [
      {
        name: "apsa-api-stub",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/api$/ }, () => ({ path: apiStub }));
          // use-capabilities imports this server function at module scope, so
          // it must resolve for the bundle even though the fixture supplies
          // capabilities through CapabilityFixtureProvider and never calls it.
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

  async function waitFor(expression: string, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
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

  return {
    evaluate,
    waitFor,
    key,
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

  test60(
    "A. revoking print_label while open (and mid-edit) clears every trace of PII",
    async () => {
      await page.reload();
      await openLabel();
      const before = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(before).toContain(value);

      // Open the correction sheet: the PII is now also in form-field values.
      await page.evaluate(clickByText(T.edit));
      await page.waitFor("document.querySelector('textarea')", "shipping sheet");
      const inFields = await page.evaluate<string>(
        "[...document.querySelectorAll('input,textarea')].map((e) => e.value).join('|')",
      );
      for (const value of PII) expect(inFields).toContain(value);

      await page.evaluate(click("revoke"));
      await page.waitFor(`!${hasButton(T.print)}`, "Print action to disappear");
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
    },
  );

  test60(
    "B. reopening stays denied with no fetch, then refetches afresh once re-granted",
    async () => {
      // Still revoked from A. Close, then reopen.
      await page.key("Escape");
      await page.waitFor(`${DIALOGS} === 0`, "label dialog closed");
      const fetchesBefore = await page.evaluate<number>("window.apsaLabelFetches.length");
      await page.evaluate(click("trigger"));
      await page.waitFor(`${DIALOGS} === 1`, "denied dialog");
      await Bun.sleep(400);
      const dump = await page.evaluate<string>(VISIBLE_PII_DUMP);
      for (const value of PII) expect(dump).not.toContain(value);
      expect(await page.evaluate<boolean>(hasButton(T.print))).toBe(false);
      expect(await page.evaluate<number>("window.apsaLabelFetches.length")).toBe(fetchesBefore);

      // Re-granting alone must not resurrect old data: the label is fetched anew.
      await page.evaluate(click("grant"));
      await page.waitFor(hasButton(T.print), "Print action after re-grant");
      expect(await page.evaluate<number>("window.apsaLabelFetches.length")).toBe(fetchesBefore + 1);
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
