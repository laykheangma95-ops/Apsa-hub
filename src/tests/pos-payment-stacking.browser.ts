/**
 * POS checkout → Record Payment sheet stacking — real-browser regression.
 *
 * The defect this pins: <BottomSheet> registers its Escape and focusin
 * handlers on `document` (see its open effect), not on its own panel. The POS
 * checkout sheet stayed open while RecordOrderPaymentSheet opened over it, so
 * two document-level focus traps ran at once. Each one's containment rule is
 * "if focus is not inside MY overlay, pull it back to MY panel", and as
 * siblings neither contains the other — so focus ping-ponged between them and
 * the amount field could not be typed into. Escape was worse: both handlers
 * fired, so dismissing the payment sheet also tore down the checkout sheet,
 * discarding the confirmed-but-unpaid order the merchant was settling.
 *
 * None of that is visible to a source-string assertion, and none of it is
 * visible to a stub: the yank is a real `focusin` event racing a real
 * `.focus()`, and the double-close is two real listeners on one real key. So
 * this file drives real Chromium over the DevTools protocol against the real
 * <PosCheckoutSheet> — real handlers, real key events, real focus. Only
 * `@/lib/api` is aliased away (see fixtures/pos-payment-stacking-api-stub.ts),
 * because reaching a confirmed-unpaid order otherwise needs a server function
 * and a database.
 *
 * Skips (loudly) when no Chromium/Chrome binary can be found.
 *
 * Run: bun test src/tests/pos-payment-stacking.browser.ts
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
    "[pos-payment-stacking.browser] SKIPPED — no Chromium/Chrome binary found. " +
      "Set APSA_CHROME_PATH to run the real-browser sheet-stacking regression.",
  );
}

// ── The merchant-visible strings, in APSA's default language ─────────────────
//
// Read from the shipped locale rather than hard-coded, so this suite keeps
// clicking the right controls when copy changes, and exercises the Khmer UI the
// merchant actually sees.
const T = {
  confirmSale: km.pos.confirmSale,
  recordPayment: km.pos.success.recordPayment,
  newSale: km.pos.success.newSale,
};

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

async function startSession(browser: string): Promise<Session> {
  /*
   * `@/lib/api` is redirected to the fixture stub for THIS bundle only. The
   * alias lives here rather than in the fixture's own imports so the fixture
   * keeps importing the component exactly as the app does — nothing in
   * src/components is aware a test is running, and no production build can
   * reach the stub.
   */
  const apiStub = path.resolve("src/tests/fixtures/pos-payment-stacking-api-stub.ts");
  const capabilitiesStub = path.resolve(
    "src/tests/fixtures/pos-payment-stacking-capabilities-stub.ts",
  );
  const build = await Bun.build({
    entrypoints: [path.resolve("src/tests/fixtures/pos-payment-stacking-page.tsx")],
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
    '<!doctype html><meta charset="utf-8"><title>pos payment stacking fixture</title>' +
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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apsa-pos-stacking-"));
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
    const wsUrl = await waitForDevToolsEndpoint(child, 30_000);
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
  const pageTarget = (await (
    await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { webSocketDebuggerUrl?: string };
  if (!pageTarget?.webSocketDebuggerUrl) throw new Error("no page target");

  const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });

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
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: server.url.origin });
  // The page must be the foreground one, or Chromium delivers no focus events
  // and every containment assertion below silently stops covering anything.
  await send("Page.bringToFront");
  await waitFor("document.getElementById('trigger')", "fixture mount");

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

/** Click the first button whose trimmed text is exactly `label`. */
const clickByText = (label: string) => `(() => {
  const target = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!target) throw new Error('no button: ' + ${JSON.stringify(label)});
  target.focus();
  target.click();
  return true;
})()`;

const DIALOG_COUNT = "document.querySelectorAll('[role=\"dialog\"]').length";
const ACTIVE_ID = "document.activeElement ? document.activeElement.id : 'none'";
/** Is focus inside the dialog that owns the payment amount field? */
const FOCUS_IN_PAYMENT_SHEET = `(() => {
  const amount = document.getElementById('order-payment-amount');
  if (!amount) return false;
  return amount.closest('[role="dialog"]').contains(document.activeElement);
})()`;
const ORDER_CODE_SHOWN = "document.body.textContent.includes('APSA-ORD-0042')";

// ── Suite ─────────────────────────────────────────────────────────────────────

const describeBrowser = BROWSER ? describe : describe.skip;

describeBrowser("POS checkout → Record Payment, real Chromium", () => {
  let page: Session;

  /**
   * Ring up the fixture's production cart and confirm it, leaving the merchant
   * on the confirmed-but-unpaid success surface — the state the whole
   * regression lives in.
   */
  async function reachConfirmedUnpaidSale(): Promise<void> {
    await page.evaluate(
      "document.getElementById('trigger').focus(); document.getElementById('trigger').click();",
    );
    await page.waitFor("document.querySelector('[role=\"dialog\"]')", "checkout sheet");
    await page.evaluate(clickByText(T.confirmSale));
    await page.waitFor(ORDER_CODE_SHOWN, "real order code on the success surface");
  }

  async function openPaymentSheet(): Promise<void> {
    await page.evaluate(clickByText(T.recordPayment));
    await page.waitFor("document.getElementById('order-payment-amount')", "payment sheet");
    /*
     * A generous fixed settle, not a wait on the assertion itself: the
     * checkout sheet leaves through an exit animation, so counting dialogs
     * immediately would be a race. Deliberately NOT `waitFor(count === 1)`,
     * which would make the assertion in A tautological — pre-fix the checkout
     * sheet never leaves at all, so no settle time rescues it.
     */
    await Bun.sleep(1500);
  }

  beforeAll(async () => {
    page = await startSession(BROWSER!);
  }, 120000);

  afterAll(async () => {
    await page?.close();
  });

  /*
   * Harness guard. Every assertion here is about where focus goes, and an
   * unfocused document delivers no focus events at all — so a suite that
   * forgot to activate its page would still pass the parts that only read
   * `activeElement`, while silently covering none of the `focusin`
   * containment that is the actual bug.
   */
  it("drives an activated page, so real focus events are delivered", async () => {
    await page.reload();
    expect(await page.evaluate<boolean>("document.hasFocus()")).toBe(true);
  });

  it("a production cart produces an authoritative order, not a fabricated one", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    // The code on screen is the server's, and the Record Payment step is
    // offered because the server's own payment axis says unpaid.
    expect(await page.evaluate<boolean>(ORDER_CODE_SHOWN)).toBe(true);
    expect(
      await page.evaluate<boolean>(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(T.recordPayment)})`,
      ),
    ).toBe(true);
  });

  it("A. only ONE sheet is mounted once payment entry opens", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    expect(await page.evaluate<number>(DIALOG_COUNT)).toBe(1);
    await openPaymentSheet();
    // Two dialogs here means two document-level traps — the defect itself.
    expect(await page.evaluate<number>(DIALOG_COUNT)).toBe(1);
  });

  it("B. the surviving trap is the payment sheet's, and it owns focus", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    expect(await page.evaluate<boolean>("!!document.getElementById('order-payment-amount')")).toBe(
      true,
    );
    expect(await page.evaluate<boolean>(FOCUS_IN_PAYMENT_SHEET)).toBe(true);
  });

  it("D. the amount field takes focus and KEEPS it", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    await page.evaluate("document.getElementById('order-payment-amount').focus()");
    // The yank was a focusin handler racing the focus, so settle before
    // reading: pre-fix the checkout trap pulls focus to its own panel here.
    await Bun.sleep(400);
    expect(await page.evaluate<string>(ACTIVE_ID)).toBe("order-payment-amount");
  });

  it("E. Tab stays inside the payment sheet", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    await page.evaluate("document.getElementById('order-payment-amount').focus()");
    await Bun.sleep(200);
    for (let press = 0; press < 6; press++) {
      await page.key("Tab");
      expect(await page.evaluate<boolean>(FOCUS_IN_PAYMENT_SHEET)).toBe(true);
    }
  });

  it("C. Escape closes ONLY the payment sheet — the sale is not completed away", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    /*
     * completeReal() clears the cart as soon as the order exists on the
     * server, so onCompleted has legitimately fired once by now. What must not
     * happen is a SECOND call: that one would come from the checkout sheet
     * being torn down, taking the merchant out of an order they have not been
     * paid for.
     */
    const completedBeforeEscape = await page.evaluate<number>("window.apsaCompletedCount");
    await page.key("Escape");
    await page.waitFor("!document.getElementById('order-payment-amount')", "payment sheet closed");
    // The checkout sheet must come back, carrying the same order...
    await page.waitFor(ORDER_CODE_SHOWN, "checkout success surface restored");
    expect(await page.evaluate<number>(DIALOG_COUNT)).toBe(1);
    // ...and Escape must not have completed the sale away.
    expect(await page.evaluate<number>("window.apsaCompletedCount")).toBe(completedBeforeEscape);
    expect(await page.evaluate<boolean>("window.apsaCheckoutOpen")).toBe(true);
  });

  it("F. closing payment restores the success surface for the SAME order", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    await page.key("Escape");
    await page.waitFor(ORDER_CODE_SHOWN, "same order still on screen");
    // Still the merchant's next step, and still their way out of the sale.
    expect(
      await page.evaluate<boolean>(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(T.recordPayment)})`,
      ),
    ).toBe(true);
    expect(
      await page.evaluate<boolean>(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(T.newSale)})`,
      ),
    ).toBe(true);
  });

  it("G. Record Payment reopens cleanly, with no stale state", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    await page.key("Escape");
    await page.waitFor("!document.getElementById('order-payment-amount')", "payment sheet closed");
    await openPaymentSheet();
    expect(await page.evaluate<number>(DIALOG_COUNT)).toBe(1);
    expect(
      await page.evaluate<string>("document.getElementById('order-payment-amount').value"),
    ).toBe("");
    await page.evaluate("document.getElementById('order-payment-amount').focus()");
    await Bun.sleep(400);
    expect(await page.evaluate<string>(ACTIVE_ID)).toBe("order-payment-amount");
  });

  it("records through the shared Payment path, idempotency key and all", async () => {
    await page.reload();
    await reachConfirmedUnpaidSale();
    await openPaymentSheet();
    await page.evaluate(`(() => {
      const amount = document.getElementById('order-payment-amount');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(amount, '12.00');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await page.evaluate(`(() => {
      const submit = [...document.querySelectorAll('[role="dialog"] button')]
        .find((b) => b.getAttribute('type') !== 'button' || b.textContent.trim().length > 0);
      return !!submit;
    })()`);
    await page.evaluate(clickByText(km.order.recordPaymentSheet.submit));
    await page.waitFor("window.apsaRecordedPayments.length === 1", "payment recorded");
    const recorded = await page.evaluate<Array<{ idempotencyKey: string; amountMinor: number }>>(
      "window.apsaRecordedPayments",
    );
    expect(recorded[0]!.amountMinor).toBe(1200);
    expect(recorded[0]!.idempotencyKey.length).toBeGreaterThan(0);
  });
});
