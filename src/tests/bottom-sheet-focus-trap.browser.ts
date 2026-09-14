/**
 * BottomSheet focus trap — real-browser regression.
 *
 * The unit half of this suite (bottom-sheet-focus-trap.test.ts) proves the
 * trap's pure rules against stubs, which is fast but cannot answer the question
 * that produced this bug: *does the browser actually focus this element?* A
 * `visibility: hidden` control and a control inside `<fieldset disabled>` both
 * look focusable to a stub — they match the selector, they have client rects,
 * and neither carries a `disabled` attribute — yet `.focus()` on either is a
 * no-op. Nested fieldsets are the same question one level harder: whether a
 * first-`<legend>` control is disabled depends on which fieldset reaches it,
 * and only the browser answers that for free. Because the sheet prevents every
 * Tab, a candidate the browser refuses to focus does not get skipped: focus
 * stays put and the merchant is stranded on the previous control. Reproduced
 * before the fix as Tab, Tab, Tab all leaving focus on #before, and as Tab
 * stalling on #deep-legend-btn once nested fieldsets were in the fixture.
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
  // Activate the tab before anything here asserts on focus.
  //
  // The target opened through /json/new is not the foreground page — Chromium
  // launches with its own new-tab page in front of it — and in an unfocused
  // document `.focus()` still moves `document.activeElement` while firing no
  // focus/focusin event at all. The sheet's containment *is* a `focusin`
  // listener, so without this the suite was driving a page where that listener
  // never ran: focusing #background left focus on #background and the
  // assertion read `background` where it expected `dialog`. The whole file
  // still passed, because dispatching real key events activates the target as
  // a side effect — so the earlier Tab tests happened to switch it on for the
  // ones after them. That is a pass that depends on test order, not on the
  // behaviour under test.
  await send("Page.bringToFront");

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
      // Re-asserted per load so no single test depends on activation
      // surviving a navigation, or on having run after another one.
      await send("Page.bringToFront");
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

  /*
   * The guard for the harness itself. Every assertion below is about where
   * focus goes, and in an unfocused document the browser delivers no focus
   * events — so a suite that forgot to activate its page would still report
   * green on the parts that only read `activeElement`, and silently stop
   * covering the `focusin` containment. Asserted first, and per fixture load,
   * so the harness fails loudly rather than degrading into a weaker test.
   */
  it("drives an activated page, so real focus events are delivered", async () => {
    await openSheet();
    expect(await page.evaluate<boolean>("document.hasFocus()")).toBe(true);
    await openSheet("?empty=1");
    expect(await page.evaluate<boolean>("document.hasFocus()")).toBe(true);
  }, 60000);

  it("counts exactly the controls Chromium will actually focus", async () => {
    await openSheet();
    const reachable = await page.evaluate<string[]>(BROWSER_TRUTH);
    const stops = await page.evaluate<string[]>("window.apsaTrapStops()");

    // The rule is checked against the platform, not against our own stubs.
    expect(stops).toEqual(reachable);
    expect(stops).toEqual([
      "name",
      "before",
      "legend-btn",
      "deep-legend-btn",
      "after",
      "fixed",
      "save",
    ]);
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

  /*
   * The nested-fieldset defect, against the platform rather than our reading
   * of it. Both ids below sit in the first <legend> of *some* disabled
   * fieldset, which is all the old rule looked for; Chromium disables one and
   * not the other, purely on which fieldset reaches it.
   */
  it("skips a first-legend control an outer disabled fieldset still reaches", async () => {
    await openSheet();
    const stops = await page.evaluate<string[]>("window.apsaTrapStops()");

    // Chromium's own verdict, stated before ours, so this test fails on the
    // platform's terms if the DOM shape ever stops being the one described.
    const platform = await page.evaluate<Record<string, boolean>>(`(() => {
      const verdict = {};
      for (const id of ['legend-btn', 'deep-legend-btn', 'deep-fs-input',
                        'nested-legend-btn', 'nested-fs-input']) {
        verdict[id] = document.getElementById(id).matches(':disabled');
      }
      return verdict;
    })()`);
    expect(platform).toEqual({
      "legend-btn": false,
      "deep-legend-btn": false,
      "deep-fs-input": true,
      "nested-legend-btn": true,
      "nested-fs-input": true,
    });

    // The two the old nearest-fieldset rule wrongly cleared.
    expect(stops).not.toContain("nested-legend-btn");
    expect(stops).not.toContain("deep-fs-input");
    // Neither carries a `disabled` attribute of its own, and both really do
    // sit under a first <legend> of a disabled fieldset — the exact shape.
    expect(
      await page.evaluate<boolean>(
        "document.getElementById('nested-legend-btn').hasAttribute('disabled')",
      ),
    ).toBe(false);
    expect(
      await page.evaluate<boolean>(
        "!!document.getElementById('nested-legend-btn').closest('fieldset[disabled] > legend:first-of-type')",
      ),
    ).toBe(true);
    // Over-excluding is the other way to strand a merchant: the genuinely
    // enabled nested legend control stays in the cycle.
    expect(stops).toContain("deep-legend-btn");
    expect(stops).not.toContain("nested-fs-input");
  }, 60000);

  /*
   * The consequence, as a merchant meets it. Tab must step from #legend-btn
   * over every disabled nested control to #deep-legend-btn and on to #after,
   * never repeating an id — a repeat is the stuck-focus signature.
   */
  it("tabs past nested disabled fieldsets instead of stalling on the control before them", async () => {
    await openSheet();
    await page.evaluate("document.getElementById('legend-btn').focus()");
    expect(await page.tab()).toBe("deep-legend-btn");
    expect(await page.tab()).toBe("after");
    // …and back out again, so neither direction dead-ends in the fieldsets.
    expect(await page.tab(true)).toBe("deep-legend-btn");
    expect(await page.tab(true)).toBe("legend-btn");
  }, 60000);

  it("advances Tab through every valid control and wraps, visiting each once", async () => {
    await openSheet();
    const visited: string[] = [];
    for (let press = 0; press < 8; press++) visited.push(await page.tab());
    expect(visited).toEqual([
      "name",
      "before",
      "legend-btn",
      "deep-legend-btn",
      "after",
      "fixed",
      "save",
      "name",
    ]);
    // The stuck-focus signature: the same id twice in a row.
    expect(visited.slice(0, 7)).toEqual([...new Set(visited.slice(0, 7))]);
  }, 60000);

  it("walks Shift+Tab back through the same controls without stalling", async () => {
    await openSheet();
    const visited: string[] = [];
    for (let press = 0; press < 8; press++) visited.push(await page.tab(true));
    expect(visited).toEqual([
      "save",
      "fixed",
      "after",
      "deep-legend-btn",
      "legend-btn",
      "before",
      "name",
      "save",
    ]);
    expect(visited.slice(0, 7)).toEqual([...new Set(visited.slice(0, 7))]);
  }, 60000);

  /*
   * The closed-<details> defect this file was reopened for. Reproduced before
   * the fix as three Tabs stuck on the <summary> and three Shift+Tabs stuck on
   * the control before the details — a collapsed control that reports a real
   * client rect and `visibility: visible` in Chromium, so the trap accepted it
   * and BottomSheet's Tab handler focused it, but `.focus()` silently no-oped.
   * Uses the separate `?details=1` fixture so its own exact tab order does not
   * have to be threaded through the assertions above.
   */
  describe("closed <details> collapsed content", () => {
    it("counts exactly the controls Chromium will actually focus while closed", async () => {
      await openSheet("?details=1");
      const reachable = await page.evaluate<string[]>(BROWSER_TRUTH);
      const stops = await page.evaluate<string[]>("window.apsaTrapStops()");
      expect(stops).toEqual(reachable);
      expect(stops).toEqual([
        "d-before",
        "d-summary",
        "d-after",
        "d-nested-outer-summary",
        "d-end",
      ]);
    }, 60000);

    it("A: forward Tab goes before -> summary -> after, never landing on the collapsed input", async () => {
      await openSheet("?details=1");
      await page.evaluate("document.getElementById('d-before').focus()");
      expect(await page.tab()).toBe("d-summary");
      expect(await page.tab()).toBe("d-after");
    }, 60000);

    it("B: reverse Shift+Tab goes after -> summary -> before, never landing on the collapsed input", async () => {
      await openSheet("?details=1");
      await page.evaluate("document.getElementById('d-after').focus()");
      expect(await page.tab(true)).toBe("d-summary");
      expect(await page.tab(true)).toBe("d-before");
    }, 60000);

    it("C: opening the details lets its inner control participate normally", async () => {
      await openSheet("?details=1");
      await page.evaluate("document.getElementById('d-details').open = true;");
      expect(await page.evaluate<string[]>("window.apsaTrapStops()")).toEqual([
        "d-before",
        "d-summary",
        "d-collapsed",
        "d-after",
        "d-nested-outer-summary",
        "d-end",
      ]);
      await page.evaluate("document.getElementById('d-summary').focus()");
      expect(await page.tab()).toBe("d-collapsed");
      expect(await page.tab()).toBe("d-after");
    }, 60000);

    it("D: a closed outer details hides an open inner details entirely, summary included", async () => {
      await openSheet("?details=1");
      // The inner details really is open — this is not "nothing to hide".
      expect(await page.evaluate<boolean>("document.getElementById('d-nested-inner').open")).toBe(
        true,
      );
      const stops = await page.evaluate<string[]>("window.apsaTrapStops()");
      expect(stops).not.toContain("d-nested-inner-summary");
      expect(stops).not.toContain("d-nested-inner-input");
      // The outer details' own eligible summary is unaffected by its child's state.
      expect(stops).toContain("d-nested-outer-summary");
    }, 60000);

    it("E: repeated Tab and Shift+Tab keep moving without ever stalling on one control", async () => {
      await openSheet("?details=1");
      const forward: string[] = [];
      for (let press = 0; press < 10; press++) forward.push(await page.tab());
      // 5 stops; two full laps with no immediate repeat anywhere in the run.
      for (let index = 1; index < forward.length; index++) {
        expect(forward[index]).not.toBe(forward[index - 1]);
      }
      expect(forward.slice(0, 5)).toEqual(forward.slice(5, 10));
      expect(forward).not.toContain("d-collapsed");
      expect(forward).not.toContain("d-nested-inner-summary");

      const backward: string[] = [];
      for (let press = 0; press < 10; press++) backward.push(await page.tab(true));
      for (let index = 1; index < backward.length; index++) {
        expect(backward[index]).not.toBe(backward[index - 1]);
      }
      expect(backward.slice(0, 5)).toEqual(backward.slice(5, 10));
      expect(backward).not.toContain("d-collapsed");
    }, 60000);
  });

  /*
   * P2-1/P2-2, the final independent re-review's two remaining defects.
   *
   * P2-1: the round-1 fix checked only the NEAREST closed <details> ancestor,
   * which missed a closed inner <details> whose own controlling <summary> is
   * still hidden by a further closed OUTER <details> above it — and also
   * missed that only the FIRST <summary> child of a details is the real
   * disclosure widget, not every element with that tag name.
   *
   * P2-2: falling straight back to the panel on a single failed `.focus()`
   * can starve traversal — the next Tab recomputes the same bad candidate
   * from the panel and resets again, never reaching a later valid control.
   * `#n-persistent-fail` reproduces a candidate that passes every structural
   * check yet genuinely refuses focus at runtime (it blurs itself the
   * instant it is focused — see the fixture), so this drives real Chromium
   * through `resolveTrapFocus`'s recovery, not just its stub-level logic.
   *
   * Uses the separate `?details-nested=1` fixture, kept apart from the
   * simpler `?details=1` one above for the same reason that one is separate
   * from the main fixture: its own exact tab order should not have to be
   * threaded through unrelated assertions.
   */
  describe("closed <details> ancestry and failed-focus recovery (P2-1/P2-2)", () => {
    // What a merchant actually experiences Tabbing through the sheet:
    // #n-persistent-fail is real HTML, a real trap candidate, and completely
    // invisible to this sequence — resolveTrapFocus skips it within the same
    // keystroke that would have landed there.
    const EFFECTIVE_STOPS = [
      "n-before",
      "n-both-closed-outer-summary",
      "n-mid1",
      "n-ooic-outer-summary",
      "n-ooic-inner-summary",
      "n-mid2",
      "n-both-open-outer-summary",
      "n-both-open-inner-summary",
      "n-both-open-inner-input",
      "n-mid3",
      "n-second-summary-first",
      "n-second-summary-input",
      "n-mid4",
      "n-after",
    ];

    it("counts the structural candidate list, and shows exactly where it diverges from what Chromium will actually focus", async () => {
      await openSheet("?details-nested=1");
      const stops = await page.evaluate<string[]>("window.apsaTrapStops()");
      const reachable = await page.evaluate<string[]>(BROWSER_TRUTH);

      // isTrapFocusable has no way to know #n-persistent-fail blurs itself —
      // it is structurally and geometrically an ordinary button, so the
      // candidate list legitimately includes it.
      expect(stops).toEqual([...EFFECTIVE_STOPS.slice(0, 13), "n-persistent-fail", "n-after"]);
      // Chromium's own focus-and-check, exactly the same test the browser
      // suite already trusts elsewhere, excludes it — this is the one
      // legitimate structural/runtime divergence resolveTrapFocus exists for.
      expect(reachable).toEqual(EFFECTIVE_STOPS);
      expect(stops).not.toEqual(reachable);
    }, 60000);

    it("A: both closed — outer's own controlling summary is reachable, the inner pair is not, however it is IS its own controlling summary", async () => {
      await openSheet("?details-nested=1");
      await page.evaluate("document.getElementById('n-before').focus()");
      expect(await page.tab()).toBe("n-both-closed-outer-summary");
      expect(await page.tab()).toBe("n-mid1");
      // The regression itself, stated as the platform's own verdict: inner's
      // controlling summary really is a <summary> whose real parent is a
      // closed <details> — it is just the WRONG closed details.
      expect(
        await page.evaluate<boolean>(
          "!!document.getElementById('n-both-closed-inner-summary').closest('details:not([open])')",
        ),
      ).toBe(true);
    }, 60000);

    it("B: outer open, inner closed — inner's controlling summary participates, its collapsed input does not", async () => {
      await openSheet("?details-nested=1");
      await page.evaluate("document.getElementById('n-ooic-outer-summary').focus()");
      expect(await page.tab()).toBe("n-ooic-inner-summary");
      expect(await page.tab()).toBe("n-mid2");
    }, 60000);

    it("C: both open — inner controls participate normally", async () => {
      await openSheet("?details-nested=1");
      await page.evaluate("document.getElementById('n-both-open-outer-summary').focus()");
      expect(await page.tab()).toBe("n-both-open-inner-summary");
      expect(await page.tab()).toBe("n-both-open-inner-input");
      expect(await page.tab()).toBe("n-mid3");
    }, 60000);

    it("D: a second <summary> is skipped — Chromium refuses it no less than any other non-stop", async () => {
      await openSheet("?details-nested=1");
      // Proven against the platform first: the second summary really is
      // there, and Chromium really will not focus it.
      expect(
        await page.evaluate<boolean>(
          "document.getElementById('n-second-summary-second').focus(); document.activeElement.id === 'n-second-summary-second'",
        ),
      ).toBe(false);
      await page.evaluate("document.getElementById('n-second-summary-first').focus()");
      expect(await page.tab()).toBe("n-second-summary-input");
      expect(await page.tab()).toBe("n-mid4");
    }, 60000);

    it("E: recovers past a candidate that refuses focus at runtime, forward and reverse, with no stuck panel cycle", async () => {
      await openSheet("?details-nested=1");
      await page.evaluate("document.getElementById('n-mid4').focus()");
      // Forward: lands on #n-after directly. #n-persistent-fail never shows
      // up as an intermediate activeElement — recovery happens inside the
      // same keystroke.
      expect(await page.tab()).toBe("n-after");
      // Reverse: the same recovery the other direction.
      expect(await page.tab(true)).toBe("n-mid4");

      // The stuck-cycle signature P2-2 named: repeated presses parked on the
      // dialog container (or on the same id) instead of ever reaching
      // #n-after. Prove several consecutive presses instead of one.
      for (let repeat = 0; repeat < 5; repeat++) {
        await page.evaluate("document.getElementById('n-mid4').focus()");
        const landed = await page.tab();
        expect(landed).toBe("n-after");
        expect(landed).not.toBe("dialog");
      }
    }, 60000);

    it("advances the full effective cycle at least twice, forward and reverse, never landing on hidden or non-controlling content", async () => {
      await openSheet("?details-nested=1");
      const forward: string[] = [];
      for (let press = 0; press < EFFECTIVE_STOPS.length * 2; press++)
        forward.push(await page.tab());
      expect(forward.slice(0, EFFECTIVE_STOPS.length)).toEqual(EFFECTIVE_STOPS);
      expect(forward.slice(0, EFFECTIVE_STOPS.length)).toEqual(
        forward.slice(EFFECTIVE_STOPS.length),
      );

      // Reopened fresh rather than reusing the forward loop's end state: the
      // forward loop's final Tab leaves focus already ON the last stop, so a
      // Shift+Tab from there steps to the second-to-last one — correct, but
      // not the "not yet inside" state a reverse walk is meant to start from.
      await openSheet("?details-nested=1");
      const backward: string[] = [];
      for (let press = 0; press < EFFECTIVE_STOPS.length * 2; press++) {
        backward.push(await page.tab(true));
      }
      expect(backward.slice(0, EFFECTIVE_STOPS.length)).toEqual([...EFFECTIVE_STOPS].reverse());
      expect(backward.slice(0, EFFECTIVE_STOPS.length)).toEqual(
        backward.slice(EFFECTIVE_STOPS.length),
      );

      for (const visited of [...forward, ...backward]) {
        expect(visited).not.toBe("n-persistent-fail");
        expect([
          "n-both-closed-inner-summary",
          "n-both-closed-inner-input",
          "n-ooic-inner-input",
          "n-second-summary-second",
        ]).not.toContain(visited);
      }
    }, 60000);
  });

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
