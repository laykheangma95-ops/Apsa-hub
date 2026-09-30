/**
 * Client navigation timing — staging/development diagnostics ONLY.
 *
 * Measures, for each in-app navigation, how long it takes from the click to:
 *   navigateMs — the router starting the navigation (onBeforeNavigate)
 *   pendingMs  — route loading starting (onBeforeLoad: guard + loaders begin)
 *   loadedMs   — route loading finishing (onLoad)
 *   renderedMs — the new route rendering (onRendered)
 *   contentMs  — first meaningful screen content: the first animation frame
 *                after render with no loading skeleton (`aria-busy="true"` or
 *                `.animate-pulse`) left on screen
 *
 * Gate: OFF unless the build sets VITE_APSA_PERF_NAV_TIMING=true. This is a
 * browser-side flag, so it is a public build-time value by design; it enables
 * console output only and carries no secret. It is separate from the server's
 * APSA_PERF_INSTRUMENTATION flag, which is never exposed to the browser.
 *
 * Privacy: screens are reported as coarse labels ("orders", "orders.detail"),
 * never a raw path — record IDs in the URL and every search param are dropped.
 * Nothing is sent anywhere; records go to the browser console and to an
 * in-memory ring buffer (`window.__apsaPerfNav`) a staging script can read.
 *
 * Observes the router only; it never changes navigation, loading or rendering.
 */

export const NAV_TIMING_FLAG = "VITE_APSA_PERF_NAV_TIMING";

/** The journeys this instrumentation exists to measure. Others are still logged. */
export const TRACKED_NAVIGATIONS: ReadonlyArray<readonly [string, string]> = [
  ["home", "orders"],
  ["orders", "pos"],
  ["pos", "customers"],
  ["customers", "products"],
  ["products", "inventory"],
  ["home", "payments"],
  ["home", "deliveries"],
];

const CONTENT_TIMEOUT_MS = 15_000;
const CLICK_WINDOW_MS = 1_000;
const RING_BUFFER_SIZE = 50;

export interface NavigationTimingRecord {
  event: "perf.navigation";
  from: string;
  to: string;
  tracked: boolean;
  navigateMs?: number;
  pendingMs?: number;
  loadedMs?: number;
  renderedMs?: number;
  contentMs?: number;
  contentTimedOut?: boolean;
}

export function isNavTimingEnabled(env: Record<string, unknown> | undefined): boolean {
  return env?.[NAV_TIMING_FLAG] === "true";
}

/**
 * "/app" → "home", "/app/orders" → "orders", "/app/orders/<id>" →
 * "orders.detail". Anything outside /app keeps only its first segment.
 */
export function screenOf(pathname: string): string {
  const segments = pathname.split(/[?#]/)[0]!.split("/").filter(Boolean);
  if (segments[0] !== "app") return segments[0] ? `public.${segments[0]}` : "public.root";
  const [, section, ...rest] = segments;
  if (!section) return "home";
  return rest.length > 0 ? `${section}.detail` : section;
}

export function isTrackedNavigation(from: string, to: string): boolean {
  return TRACKED_NAVIGATIONS.some(([f, t]) => f === from && t === to);
}

interface NavEvent {
  fromLocation?: { pathname: string };
  toLocation: { pathname: string };
  pathChanged: boolean;
}

type NavEventType = "onBeforeNavigate" | "onBeforeLoad" | "onLoad" | "onRendered";

export interface RouterLike {
  subscribe(eventType: NavEventType, fn: (event: NavEvent) => void): () => void;
}

export interface NavTimingDeps {
  now: () => number;
  requestFrame: (cb: () => void) => void;
  /** True while a loading skeleton is still on screen. */
  isLoadingVisible: () => boolean;
  /** Registers the click listener; returns nothing. */
  onClick: (cb: () => void) => void;
  emit: (record: NavigationTimingRecord) => void;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Wire timing onto a router. Returns an unsubscribe function. */
export function attachNavigationTiming(router: RouterLike, deps: NavTimingDeps): () => void {
  let lastClickAt: number | undefined;
  let active:
    { id: number; origin: number; record: NavigationTimingRecord; emitted: boolean } | undefined;
  let nextId = 0;

  deps.onClick(() => {
    lastClickAt = deps.now();
  });

  const since = (origin: number) => round(deps.now() - origin);

  const finish = () => {
    if (!active || active.emitted) return;
    active.emitted = true;
    try {
      deps.emit(active.record);
    } catch {
      // Diagnostics must never affect the app.
    }
  };

  const waitForContent = (id: number) => {
    const check = () => {
      if (!active || active.id !== id || active.emitted) return;
      const elapsed = deps.now() - active.origin;
      if (!deps.isLoadingVisible()) {
        active.record.contentMs = round(elapsed);
        finish();
      } else if (elapsed > CONTENT_TIMEOUT_MS) {
        active.record.contentTimedOut = true;
        finish();
      } else {
        deps.requestFrame(check);
      }
    };
    deps.requestFrame(check);
  };

  const unsubscribers = [
    router.subscribe("onBeforeNavigate", (event) => {
      if (!event.pathChanged) return;
      // A navigation superseded before its content appeared is still reported.
      finish();
      const at = deps.now();
      const clicked = lastClickAt !== undefined && at - lastClickAt <= CLICK_WINDOW_MS;
      const origin = clicked ? lastClickAt! : at;
      lastClickAt = undefined;
      const from = screenOf(event.fromLocation?.pathname ?? "");
      const to = screenOf(event.toLocation.pathname);
      active = {
        id: ++nextId,
        origin,
        emitted: false,
        record: {
          event: "perf.navigation",
          from,
          to,
          tracked: isTrackedNavigation(from, to),
          navigateMs: round(at - origin),
        },
      };
    }),
    router.subscribe("onBeforeLoad", (event) => {
      if (active && event.pathChanged && active.record.pendingMs === undefined) {
        active.record.pendingMs = since(active.origin);
      }
    }),
    router.subscribe("onLoad", (event) => {
      if (active && event.pathChanged && active.record.loadedMs === undefined) {
        active.record.loadedMs = since(active.origin);
      }
    }),
    router.subscribe("onRendered", (event) => {
      if (!active || !event.pathChanged || active.record.renderedMs !== undefined) return;
      active.record.renderedMs = since(active.origin);
      waitForContent(active.id);
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

declare global {
  interface Window {
    __apsaPerfNav?: NavigationTimingRecord[];
  }
}

const installed = new WeakSet<object>();

/**
 * Browser entry point. A no-op on the server, when the flag is off, or when
 * this router already has timing attached.
 */
export function installNavigationTiming(router: RouterLike): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!isNavTimingEnabled(import.meta.env as Record<string, unknown> | undefined)) return;
  if (installed.has(router)) return;
  installed.add(router);

  attachNavigationTiming(router, {
    now: () => performance.now(),
    requestFrame: (cb) => window.requestAnimationFrame(() => cb()),
    isLoadingVisible: () => document.querySelector('[aria-busy="true"], .animate-pulse') !== null,
    onClick: (cb) => document.addEventListener("click", cb, { capture: true, passive: true }),
    emit: (record) => {
      const buffer = (window.__apsaPerfNav ??= []);
      buffer.push(record);
      if (buffer.length > RING_BUFFER_SIZE) buffer.splice(0, buffer.length - RING_BUFFER_SIZE);
      console.info("[apsa.perf]", JSON.stringify(record));
    },
  });
}
