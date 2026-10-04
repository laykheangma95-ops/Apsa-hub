/**
 * React hydration #418 — language consistency regressions.
 *
 * The bug: SSR always rendered Khmer, and a browser whose saved preference was
 * English (localStorage "apsa.language" = "en") switched i18n to English while
 * React was still hydrating. Route content behind Suspense then hydrated in
 * English against Khmer server HTML: a recoverable hydration error, and React
 * discarded and client-rendered the subtree.
 *
 * Invariant under test: the server's first render and the browser's first
 * hydration render use the same language.
 *
 * Phase 1 (no DOM — a real server environment):
 *   - SSR through the REAL root route (src/routes/__root.tsx) and a real
 *     TanStack router, with `getCookie` answering per request from an
 *     AsyncLocalStorage, the way h3 scopes cookies to one request. Many
 *     interleaved concurrent renders with different cookies prove no request
 *     can see another's language, and that the process-wide i18n instance is
 *     never switched.
 * Phase 2 (happy-dom registered only after phase 1):
 *   - SSR → hydrateRoot of the real LanguageProvider, with route content behind
 *     a Suspense boundary whose code arrives only AFTER the provider's mount
 *     effects have run — exactly the window in which the old provider switched
 *     language. Any recoverable error fails the test.
 *
 * Runs in its own process (i18n-hydration.test.ts): it mocks
 * @tanstack/react-start/server and installs DOM globals.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createElement,
  lazy,
  memo,
  Suspense,
  use,
  useEffect,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { renderToReadableStream } from "react-dom/server";
import km from "@/locales/km.json";
import en from "@/locales/en.json";
import {
  LANGUAGE_COOKIE,
  LANGUAGE_STORAGE_KEY,
  readCookieValue,
  ssrLanguageFromCookie,
} from "@/lib/language";
import type { Language } from "@/types";

// Harness noise only: bun loads Vite's `styles.css?url` as a module object, and
// React warns when its server and client renderers (one process here, never in
// production) touch the same context. Every other console.error surfaces.
const HARNESS_NOISE = [
  /`precedence` prop and expected the `href` prop/,
  /multiple renderers concurrently/,
];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const message = args.map(String).join(" ");
  if (HARNESS_NOISE.some((re) => re.test(message))) return;
  originalConsoleError(...args);
};

// ── Per-request cookie, scoped like h3's request event ───────────────────────

const requestCookies = new AsyncLocalStorage<{ language: string | undefined }>();
mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) =>
    name === LANGUAGE_COOKIE ? requestCookies.getStore()?.language : undefined,
}));

// Imported after the mock so the root route's server branch reads it.
const {
  LanguageProvider,
  useLanguage,
  useTranslation,
  default: globalI18n,
} = await import("@/lib/i18n");

const TITLE_KEY = "auth.signIn.head.title";
const BODY_KEY = "settings.app.language";
const COPY: Record<Language, { title: string; body: string }> = {
  km: { title: km.auth.signIn.head.title, body: km.settings.app.language },
  en: { title: en.auth.signIn.head.title, body: en.settings.app.language },
};
const other = (lang: Language): Language => (lang === "km" ? "en" : "km");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await tick(5);
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

// ── Shared component tree (server and client render the same thing) ──────────

/** Every render's language, so a flash between languages is observable. */
let renderLog: Array<{ language: Language; title: string }> = [];

/** Language of every render of the route content. */
let routeRenderLog: string[] = [];

function RouteBody() {
  const { t, i18n } = useTranslation();
  routeRenderLog.push(i18n.language);
  return createElement(
    "section",
    { id: "route" },
    createElement("p", { id: "body" }, t(BODY_KEY)),
    createElement("span", { id: "route-lng" }, i18n.language),
  );
}

/**
 * Calls `onMount` from a passive effect of the hydration commit. A child's
 * effect runs before LanguageProvider's own. Renders nothing; never runs on
 * the server.
 */
function MountEffect({ onMount }: { onMount?: () => void }) {
  useEffect(() => {
    onMount?.();
  }, [onMount]);
  return null;
}

/** Like TanStack's memoized route Match: parent re-renders do not reach it. */
const RouteOutlet = memo(function RouteOutlet({
  Body,
}: {
  Body: LazyExoticComponent<ComponentType>;
}) {
  return createElement(
    Suspense,
    { fallback: createElement("p", { id: "fallback" }, "…") },
    createElement(Body),
  );
});

function Page({
  Body,
  onMount,
}: {
  Body: LazyExoticComponent<ComponentType>;
  onMount?: () => void;
}) {
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation();
  const title = t(TITLE_KEY);
  renderLog.push({ language, title });
  // Mirrors the root document: lang and data-lang from the provider.
  return createElement(
    "div",
    { id: "doc", lang: language, "data-lang": language },
    createElement("h1", { id: "title" }, title),
    createElement("button", { id: "to-en", type: "button", onClick: () => setLanguage("en") }),
    createElement("button", { id: "to-km", type: "button", onClick: () => setLanguage("km") }),
    createElement(RouteOutlet, { Body }),
    createElement(MountEffect, { onMount }),
  );
}

function App({
  initialLanguage,
  Body,
  onMount,
}: {
  initialLanguage: Language;
  Body: LazyExoticComponent<ComponentType>;
  onMount?: () => void;
}) {
  // `initialLanguage` is ignored by a provider that does not accept it — the
  // pre-repair provider rendered Khmer regardless.
  return createElement(
    LanguageProvider as any,
    { initialLanguage },
    createElement(Page, { Body, onMount }),
  );
}

/** Route code that arrives only when `release()` is called. */
function deferredRouteChunk() {
  let resolve!: (mod: { default: ComponentType }) => void;
  const chunk = new Promise<{ default: ComponentType }>((r) => (resolve = r));
  return { Body: lazy(() => chunk), release: () => resolve({ default: RouteBody }) };
}

/** Server render. The language comes from the cookie exactly as the root route resolves it. */
async function serverRender(cookie: string | undefined) {
  const language = ssrLanguageFromCookie(cookie);
  const { Body, release } = deferredRouteChunk();
  release();
  const stream = await renderToReadableStream(
    createElement(App, { initialLanguage: language, Body }),
  );
  await stream.allReady;
  return { html: await streamToString(stream), language };
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 1 — server only (no DOM)
// ═════════════════════════════════════════════════════════════════════════════

describe("SSR through the real root route", () => {
  it("H. concurrent requests (en / km interleaved) never leak language; the global instance is never switched", async () => {
    expect(typeof document).toBe("undefined");
    const Router = await import("@tanstack/react-router");
    const { QueryClient } = await import("@tanstack/react-query");
    const { Route: RootRoute } = await import("@/routes/__root");

    // Route content that suspends mid-render for a random time PER REQUEST,
    // after the request's LanguageProvider has rendered — so renders of
    // different languages are genuinely in flight at the same time.
    const pausesByRouter = new WeakMap<object, Promise<void>>();
    let inFlight = 0;
    let maxInFlight = 0;
    function SlowBody() {
      const router = Router.useRouter();
      let pause = pausesByRouter.get(router);
      if (!pause) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pause = tick(Math.random() * 15).then(() => {
          inFlight -= 1;
        });
        pausesByRouter.set(router, pause);
      }
      use(pause);
      const { t, i18n } = useTranslation();
      return createElement(
        "main",
        null,
        createElement("p", { "data-probe": "title" }, t(TITLE_KEY)),
        createElement("p", { "data-probe": "lng" }, i18n.language),
      );
    }
    const index = Router.createRoute({
      getParentRoute: () => RootRoute,
      path: "/",
      component: SlowBody,
    });
    const routeTree = RootRoute.addChildren([index]);

    async function renderRequest(cookie: string | undefined): Promise<string> {
      return requestCookies.run({ language: cookie }, async () => {
        const router = Router.createRouter({
          routeTree,
          isServer: true,
          history: Router.createMemoryHistory({ initialEntries: ["/"] }),
          context: { queryClient: new QueryClient() },
        } as any);
        await tick(Math.random() * 10);
        await router.load();
        const stream = await renderToReadableStream(
          createElement(Router.RouterProvider, { router } as any),
        );
        await stream.allReady;
        return streamToString(stream);
      });
    }

    const ROUNDS = 40;
    const cookies = Array.from({ length: ROUNDS * 2 }, (_, i) => (i % 2 === 0 ? "en" : "km"));
    const pages = await Promise.all(cookies.map((cookie) => renderRequest(cookie)));
    // The renders really did overlap.
    expect(maxInFlight).toBeGreaterThan(10);

    pages.forEach((html, i) => {
      const lang = cookies[i] as Language;
      expect(html).toContain(`<html lang="${lang}" data-lang="${lang}">`);
      expect(html).toContain(`<p data-probe="title">${COPY[lang].title}</p>`);
      expect(html).toContain(`<p data-probe="lng">${lang}</p>`);
      expect(html).not.toContain(COPY[other(lang)].title);
    });
    // SSR never switches the process-wide instance.
    expect(globalI18n.language).toBe("km");

    // F. invalid / missing cookie → Khmer, deterministically.
    for (const bad of [undefined, "", "EN", "fr", "en;", " en", "km\u0000", "null"]) {
      const html = await renderRequest(bad);
      expect(html).toContain(`<html lang="km" data-lang="km">`);
      expect(html).toContain(COPY.km.title);
    }
  }, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — hydration in a browser-like DOM
// ═════════════════════════════════════════════════════════════════════════════

describe("hydration", () => {
  let hydrateRoot: typeof import("react-dom/client").hydrateRoot;
  let act: (cb: () => void) => void;

  it("installs a DOM only after the server phase", async () => {
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    ({ hydrateRoot } = await import("react-dom/client"));
    act = (cb) => cb();
    expect(typeof document).toBe("object");
  });

  function resetBrowser({ cookie, stored }: { cookie?: string; stored?: string }) {
    document.cookie = `${LANGUAGE_COOKIE}=; Path=/; Max-Age=0`;
    window.localStorage.clear();
    if (cookie !== undefined) document.cookie = `${LANGUAGE_COOKIE}=${cookie}; Path=/`;
    if (stored !== undefined) window.localStorage.setItem(LANGUAGE_STORAGE_KEY, stored);
    document.body.innerHTML = "";
  }

  /**
   * When the route chunk reaches the browser, relative to hydration. In every
   * case the route's Suspense boundary is still dehydrated when the shell's
   * mount effects run — the window in which the old provider switched
   * language.
   *  - "during-commit": the chunk's promise settles during the hydration
   *    commit, so it is available by the time React processes updates the
   *    mount effects scheduled. React then hydrates the boundary selectively.
   *    The old provider: React #418, text content mismatch.
   *  - "after-commit": the chunk settles in a microtask after the commit.
   *  - "late": after everything has settled.
   *    The old provider, both: React discarded the server-rendered route
   *    subtree and client-rendered it.
   */
  type ChunkTiming = "during-commit" | "after-commit" | "late";
  const TIMINGS: ChunkTiming[] = ["during-commit", "after-commit", "late"];

  /** One full page load: SSR with the browser's cookie, then hydrate. */
  async function fullPageLoad(timing: ChunkTiming) {
    const cookie = readCookieValue(document.cookie, LANGUAGE_COOKIE) ?? undefined;
    const server = await serverRender(cookie);
    const container = document.createElement("div");
    container.innerHTML = server.html;
    document.body.appendChild(container);
    // Hydration adopts these exact nodes; a discarded subtree replaces them.
    const serverRouteNode = container.querySelector("#route");
    const serverTitleNode = container.querySelector("#title");

    const recoverable: unknown[] = [];
    const consoleErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    renderLog = [];
    routeRenderLog = []; // client renders only from here on
    const { Body, release } = deferredRouteChunk();
    let root!: ReturnType<typeof hydrateRoot>;
    try {
      act(() => {
        root = hydrateRoot(
          container,
          // The dehydrated route context carries the server's language.
          createElement(App, {
            initialLanguage: server.language,
            Body,
            onMount:
              timing === "during-commit"
                ? release
                : timing === "after-commit"
                  ? () => queueMicrotask(release)
                  : undefined,
          }),
          { onRecoverableError: (error) => recoverable.push(error) },
        );
      });
      await settle(); // shell hydrated, mount effects ran
      release(); // no-op if already released
      await settle();
    } finally {
      console.error = originalError;
    }
    const text = (sel: string) => container.querySelector(sel)?.textContent;
    return {
      server,
      container,
      root,
      recoverable,
      consoleErrors,
      rendered: renderLog,
      routeRendered: routeRenderLog,
      adoptedServerDom:
        serverRouteNode !== null &&
        container.querySelector("#route") === serverRouteNode &&
        container.querySelector("#title") === serverTitleNode,
      title: text("#title"),
      body: text("#body"),
      routeLng: text("#route-lng"),
      docLang: container.querySelector("#doc")?.getAttribute("lang"),
      docDataLang: container.querySelector("#doc")?.getAttribute("data-lang"),
      cookie: () => readCookieValue(document.cookie, LANGUAGE_COOKIE),
      stored: () => window.localStorage.getItem(LANGUAGE_STORAGE_KEY),
    };
  }

  function expectCleanHydration(load: Awaited<ReturnType<typeof fullPageLoad>>) {
    expect(load.recoverable.map(String)).toEqual([]);
    // The route content first rendered on the client in the server's
    // language — a different language here IS the hydration mismatch.
    expect(load.routeRendered[0]).toBe(load.server.language);
    // The server's route subtree was hydrated, not discarded and re-rendered.
    expect(load.adoptedServerDom).toBe(true);
    expect(load.consoleErrors.filter((m) => /hydrat|did not match|418/i.test(m))).toEqual([]);
  }

  function expectShows(load: Awaited<ReturnType<typeof fullPageLoad>>, lang: Language) {
    expect(load.title).toBe(COPY[lang].title);
    expect(load.body).toBe(COPY[lang].body);
    expect(load.routeLng).toBe(lang);
    expect(load.docLang).toBe(lang);
    expect(load.docDataLang).toBe(lang);
  }

  // Precedence: valid cookie → valid legacy localStorage → SSR default (km).
  const matrix: Array<{
    name: string;
    cookie?: string;
    stored?: string;
    ssr: Language;
    settled: Language;
  }> = [
    { name: "legacy en + no cookie", stored: "en", ssr: "km", settled: "en" },
    { name: "legacy km + no cookie", stored: "km", ssr: "km", settled: "km" },
    { name: "cookie en + localStorage km", cookie: "en", stored: "km", ssr: "en", settled: "en" },
    { name: "cookie km + localStorage en", cookie: "km", stored: "en", ssr: "km", settled: "km" },
    { name: "F. invalid cookie", cookie: "EN", ssr: "km", settled: "km" },
    { name: "F. invalid cookie + legacy en", cookie: "fr", stored: "en", ssr: "km", settled: "en" },
    { name: "G. invalid localStorage", stored: "english", ssr: "km", settled: "km" },
    {
      name: "G. invalid localStorage + cookie en",
      cookie: "en",
      stored: "xx",
      ssr: "en",
      settled: "en",
    },
    { name: "neither present", ssr: "km", settled: "km" },
  ];
  for (const timing of TIMINGS) {
    it(`[${timing}] A. SSR Khmer → hydrate Khmer: no recoverable error, no flash`, async () => {
      resetBrowser({ cookie: "km" });
      const load = await fullPageLoad(timing);
      expect(load.server.html).toContain(COPY.km.title);
      expectCleanHydration(load);
      expectShows(load, "km");
      expect(new Set(load.rendered.map((r) => r.language))).toEqual(new Set(["km"]));
      load.root.unmount();
    });

    it(`[${timing}] B. SSR English → hydrate English: no recoverable error, no flash`, async () => {
      resetBrowser({ cookie: "en", stored: "en" });
      const load = await fullPageLoad(timing);
      expect(load.server.html).toContain(COPY.en.title);
      expect(load.server.html).toContain('lang="en"');
      expectCleanHydration(load);
      expectShows(load, "en");
      expect(new Set(load.rendered.map((r) => r.language))).toEqual(new Set(["en"]));
      load.root.unmount();
    });

    it(`[${timing}] C. legacy localStorage English + no cookie: hydrates Khmer cleanly, then migrates once; the next load is English from SSR`, async () => {
      resetBrowser({ stored: "en" });
      const first = await fullPageLoad(timing);
      expect(first.server.language).toBe("km");
      expectCleanHydration(first);
      // Adopted only after hydration completed, then persisted for SSR.
      expectShows(first, "en");
      expect(first.cookie()).toBe("en");
      first.root.unmount();

      // E. The next full load SSRs English: no mismatch and no flash.
      document.body.innerHTML = "";
      const second = await fullPageLoad(timing);
      expect(second.server.language).toBe("en");
      expect(second.server.html).toContain(COPY.en.title);
      expectCleanHydration(second);
      expectShows(second, "en");
      expect(new Set(second.rendered.map((r) => r.language))).toEqual(new Set(["en"]));
      second.root.unmount();
    });

    it(`[${timing}] D/E. switching language persists the server-visible cookie; the next SSR uses it`, async () => {
      resetBrowser({ cookie: "km" });
      const load = await fullPageLoad(timing);
      expectShows(load, "km");
      (load.container.querySelector("#to-en") as HTMLButtonElement).click();
      await settle();
      expect(load.container.querySelector("#title")?.textContent).toBe(COPY.en.title);
      expect(load.container.querySelector("#doc")?.getAttribute("lang")).toBe("en");
      expect(load.cookie()).toBe("en");
      expect(load.stored()).toBe("en");
      expect(document.cookie).not.toMatch(/user|org|token/i);
      load.root.unmount();

      const next = await serverRender(
        readCookieValue(document.cookie, LANGUAGE_COOKIE) ?? undefined,
      );
      expect(next.language).toBe("en");
      expect(next.html).toContain(COPY.en.title);

      // …and back to Khmer.
      resetBrowser({ cookie: "en" });
      const back = await fullPageLoad(timing);
      (back.container.querySelector("#to-km") as HTMLButtonElement).click();
      await settle();
      expect(back.container.querySelector("#title")?.textContent).toBe(COPY.km.title);
      expect(back.cookie()).toBe("km");
      back.root.unmount();
      expect((await serverRender("km")).html).toContain(COPY.km.title);
    });

    for (const row of matrix) {
      it(`[${timing}] precedence: ${row.name} → SSR ${row.ssr}, settles ${row.settled}, hydration clean`, async () => {
        resetBrowser({ cookie: row.cookie, stored: row.stored });
        const load = await fullPageLoad(timing);
        expect(load.server.language).toBe(row.ssr);
        expectCleanHydration(load);
        expectShows(load, row.settled);
        // Both stores end up agreeing with the settled language.
        expect(load.cookie()).toBe(row.settled);
        expect(load.stored()).toBe(row.settled);
        // The first render — the hydration render — was the SSR language.
        expect(load.rendered[0]?.language).toBe(row.ssr);
        load.root.unmount();
      });
    }
  }
});
