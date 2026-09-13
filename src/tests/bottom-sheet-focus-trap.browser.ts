/**
 * BottomSheet focus trap — real-browser regression.
 *
 * The unit half of this suite (bottom-sheet-focus-trap.test.ts) proves the
 * trap's pure rules against stubs, which is fast but cannot answer the question
 * that produced this bug: *does the browser actually focus this element?* A
 * `visibility: hidden` control and a control inside `<fieldset disabled>` both
 * look focusable to a stub — they match the selector, they have client rects,
 * and neither carries a `disabled` attribute — yet `.focus()` on either is a
 * no-op. Because the sheet prevents every Tab, a candidate the browser refuses
 * to focus does not get skipped: focus stays put and the merchant is stranded
 * on the previous control. Reproduced before the fix as Tab, Tab, Tab all
 * leaving focus on #before.
 *
 * So this file drives real Chromium over the DevTools protocol against the real
 * <BottomSheet>: real handlers, real layout, real computed style, real key
 * events. No new dependency — Bun bundles the fixture, serves it, and speaks
 * CDP over the WebSocket it already has.
 *
 * Skips (loudly) when no Chromium/Chrome binary can be found.
 *
 * Run: bun test src/tests/bottom-sheet-focus-trap.browser.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    "[bottom-sheet-focus-trap.browser] SKIPPED — no Chromium/Chrome binary found. " +
      "Set APSA_CHROME_PATH to run the real-browser focus-trap regression.",
  );
}

// ── CDP session ───────────────────────────────────────────────────────────────

interface Session {
  /** Load a fixture URL and wait for React to have mounted the trigger. */
  open(query: string): Promise<void>;
  /** Evaluate an expression in the page and return its value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Press Tab (or Shift+Tab) and return the id of whatever holds focus after. */
  tab(shiftKey?: boolean): Promise<string>;
  /** Type one printable character as real key events. */
  type(text: string): Promise<void>;
  /** Press Escape. */
  escape(): Promise<void>;
  close(): Promise<void>;
}

async function startSession(browser: string): Promise<Session> {
  const build = await Bun.build({
    entrypoints: [path.resolve("src/tests/fixtures/bottom-sheet-focus-trap-page.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const js = await build.outputs[0]!.text();
  const html =
    '<!doctype html><meta charset="utf-8"><title>focus trap fixture</title>' +
    '<body><div id="root"></div><script type="module" src="/app.js"></script>';

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const headers =
        new URL(request.url).pathname === "/app.js"
          ? { "content-type": "text/javascript" }
          : { "content-type": "text/html" };
      return new Response(new URL(request.url).pathname === "/app.js" ? js : html, { headers });
    },
  });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apsa-focus-trap-"));
  const child = Bun.spawn(
    [
      browser,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--mute-audio",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  // Chromium writes the port it actually took into the profile directory.
  const portFile = path.join(profile, "DevToolsActivePort");
  let endpoint = "";
  for (let attempt = 0; attempt < 200 && !endpoint; attempt++) {
    await Bun.sleep(50);
    if (!fs.existsSync(portFile)) continue;
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0]?.trim();
    if (port) endpoint = `http://127.0.0.1:${port}`;
  }
  if (!endpoint) throw new Error("Chromium never reported a DevTools port");

  const target = (await (
    await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { webSocketDebuggerUrl: string };

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("CDP socket failed to open"));
  });

  let nextId = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");

  async function evaluate<T>(expression: string): Promise<T> {
    const reply = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { exceptionDetails?: unknown; result?: { value?: T } } };
    if (reply.result?.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(reply.result.exceptionDetails)}`);
    }
    return reply.result?.result?.value as T;
  }

  async function key(
    key_: string,
    code: string,
    keyCode: number,
    modifiers = 0,
    text?: string,
  ): Promise<void> {
    const common = {
      key: key_,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    };
    await send("Input.dispatchKeyEvent", {
      ...common,
      type: text === undefined ? "rawKeyDown" : "keyDown",
      ...(text === undefined ? {} : { text }),
    });
    await send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
    await Bun.sleep(30);
  }

  return {
    async open(query: string) {
      await send("Page.navigate", { url: `${server.url.origin}/${query}` });
      for (let attempt = 0; attempt < 200; attempt++) {
        await Bun.sleep(25);
        if (await evaluate<boolean>("!!document.getElementById('trigger')")) return;
      }
      throw new Error("fixture never mounted");
    },
    evaluate,
    async tab(shiftKey = false) {
      await key("Tab", "Tab", 9, shiftKey ? 8 : 0);
      return evaluate<string>(
        "document.activeElement ? (document.activeElement.id || document.activeElement.getAttribute('role') || document.activeElement.tagName) : 'none'",
      );
    },
    async type(text: string) {
      for (const character of text) {
        await key(
          character,
          `Key${character.toUpperCase()}`,
          character.toUpperCase().charCodeAt(0),
          0,
          character,
        );
      }
    },
    async escape() {
      await key("Escape", "Escape", 27);
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

// ── Suite ─────────────────────────────────────────────────────────────────────

const describeBrowser = BROWSER ? describe : describe.skip;

describeBrowser("BottomSheet focus trap — real Chromium", () => {
  let page: Session;

  /** Open the populated fixture with the sheet showing, focus on the panel. */
  async function openSheet(query = ""): Promise<void> {
    await page.open(query);
    // Focused first, then clicked: a bare programmatic click leaves focus on
    // <body>, and the sheet restores focus to whatever held it on open.
    await page.evaluate(
      "document.getElementById('trigger').focus(); document.getElementById('trigger').click();",
    );
    for (let attempt = 0; attempt < 200; attempt++) {
      await Bun.sleep(25);
      if (await page.evaluate<boolean>("!!document.querySelector('[role=\"dialog\"]')")) return;
    }
    throw new Error("sheet never opened");
  }

  /** The ids Chromium itself will hand focus to, in DOM order. */
  const BROWSER_TRUTH = `(() => {
    const panel = document.querySelector('[role="dialog"]');
    const reachable = [];
    for (const element of panel.querySelectorAll('[id]')) {
      element.focus();
      if (document.activeElement === element) reachable.push(element.id);
    }
    panel.focus();
    return reachable;
  })()`;

  beforeAll(async () => {
    page = await startSession(BROWSER!);
  }, 120000);

  afterAll(async () => {
    await page?.close();
  });

  it("counts exactly the controls Chromium will actually focus", async () => {
    await openSheet();
    const reachable = await page.evaluate<string[]>(BROWSER_TRUTH);
    const stops = await page.evaluate<string[]>("window.apsaTrapStops()");

    // The rule is checked against the platform, not against our own stubs.
    expect(stops).toEqual(reachable);
    expect(stops).toEqual(["name", "before", "legend-btn", "after", "fixed", "save"]);
  }, 60000);

  it("skips a visibility:hidden candidate instead of stalling on the control before it", async () => {
    await openSheet();
    // #invisible sits between #before and the fieldset. Before the fix, Tab
    // chose it, .focus() did nothing, and focus stayed on #before for good.
    expect(await page.tab()).toBe("name");
    expect(await page.tab()).toBe("before");
    const advanced = await page.tab();
    expect(advanced).not.toBe("before");
    expect(advanced).toBe("legend-btn");
  }, 60000);

  it("skips descendants of <fieldset disabled> that carry no disabled attribute", async () => {
    await openSheet();
    const stops = await page.evaluate<string[]>("window.apsaTrapStops()");
    expect(stops).not.toContain("fs-input");
    expect(stops).not.toContain("fs-btn");
    // The attribute really is absent — the old check had nothing to find.
    expect(
      await page.evaluate<boolean>("document.getElementById('fs-input').hasAttribute('disabled')"),
    ).toBe(false);
    // …and the first <legend>'s control stays reachable, as HTML requires.
    expect(stops).toContain("legend-btn");
  }, 60000);

  it("advances Tab through every valid control and wraps, visiting each once", async () => {
    await openSheet();
    const visited: string[] = [];
    for (let press = 0; press < 7; press++) visited.push(await page.tab());
    expect(visited).toEqual(["name", "before", "legend-btn", "after", "fixed", "save", "name"]);
    // The stuck-focus signature: the same id twice in a row.
    expect(visited.slice(0, 6)).toEqual([...new Set(visited.slice(0, 6))]);
  }, 60000);

  it("walks Shift+Tab back through the same controls without stalling", async () => {
    await openSheet();
    const visited: string[] = [];
    for (let press = 0; press < 7; press++) visited.push(await page.tab(true));
    expect(visited).toEqual(["save", "fixed", "after", "legend-btn", "before", "name", "save"]);
  }, 60000);

  it("never lets Tab reach the page behind the sheet", async () => {
    await openSheet();
    const outside = ["background", "trigger"];
    for (let press = 0; press < 14; press++) {
      const active = await page.tab(press % 3 === 2);
      expect(outside).not.toContain(active);
      expect(
        await page.evaluate<boolean>(
          "document.querySelector('[role=\"dialog\"]').contains(document.activeElement)",
        ),
      ).toBe(true);
    }
  }, 60000);

  it("pulls focus back inside when something outside the overlay takes it", async () => {
    await openSheet();
    await page.evaluate("document.getElementById('background').focus()");
    await Bun.sleep(50);
    expect(
      await page.evaluate<string>(
        "document.activeElement.getAttribute('role') || document.activeElement.id",
      ),
    ).toBe("dialog");
  }, 60000);

  it("swallows Tab on a sheet with no tab stops at all", async () => {
    await openSheet("?empty=1");
    expect(await page.evaluate<string[]>("window.apsaTrapStops()")).toEqual([]);
    for (let press = 0; press < 3; press++) {
      expect(await page.tab(press === 1)).toBe("dialog");
    }
  }, 60000);

  it("keeps a controlled input focused across repeated keystrokes", async () => {
    await openSheet();
    await page.evaluate("document.getElementById('name').focus()");
    await page.type("abc");
    expect(await page.evaluate<string>("document.activeElement.id")).toBe("name");
    expect(await page.evaluate<string>("document.getElementById('name').value")).toBe("abc");
  }, 60000);

  it("locks body scroll while open and restores focus to the trigger on Escape", async () => {
    await openSheet();
    expect(await page.evaluate<string>("document.body.style.overflow")).toBe("hidden");
    await page.escape();
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(25);
      if (!(await page.evaluate<boolean>("!!document.querySelector('[role=\"dialog\"]')"))) break;
    }
    expect(await page.evaluate<boolean>("!!document.querySelector('[role=\"dialog\"]')")).toBe(
      false,
    );
    expect(await page.evaluate<string>("document.body.style.overflow")).toBe("");
    expect(await page.evaluate<string>("document.activeElement.id")).toBe("trigger");
  }, 60000);
});
