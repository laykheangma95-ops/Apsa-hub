/**
 * Which screen the console was opened from.
 *
 * A UX HINT AND NOTHING ELSE. It reorders the shortcuts so the tool the member
 * most likely wants is at the top of the sheet. It never changes what may be
 * looked up, never widens or narrows a permission, and is never sent to the
 * server as a claim — the surface is derived from the current pathname, which
 * is client input by definition.
 *
 * Safe to bundle for the browser: pure string work, no imports.
 */
export type ApsiSurface = "inbox" | "sales" | "catalog" | "home" | "other";

export function apsiSurfaceForPath(pathname: string): ApsiSurface {
  if (pathname.startsWith("/app/inbox")) return "inbox";
  if (
    pathname.startsWith("/app/orders") ||
    pathname.startsWith("/app/payments") ||
    pathname.startsWith("/app/deliveries") ||
    pathname.startsWith("/app/pos")
  ) {
    return "sales";
  }
  if (pathname.startsWith("/app/products") || pathname.startsWith("/app/inventory")) {
    return "catalog";
  }
  if (pathname === "/app") return "home";
  return "other";
}

/**
 * The shortcut ids this surface leads with. Anything not listed keeps its
 * declared order after them, so a new shortcut is never silently dropped by
 * being absent from one of these lists.
 */
const SURFACE_PRIORITY: Readonly<Record<ApsiSurface, readonly string[]>> = {
  // Answering the customer in front of you: who they are, what they ordered,
  // whether it is paid, where it is.
  inbox: ["find-customer", "find-order", "check-payment", "track-delivery"],
  sales: ["find-order", "check-payment", "track-delivery", "check-stock"],
  catalog: ["find-product", "check-stock", "scan-barcode"],
  home: [],
  other: [],
};

/** Stable reordering: priority ids first in their listed order, rest untouched. */
export function orderApsiActionIds(
  ids: readonly string[],
  surface: ApsiSurface,
): readonly string[] {
  const priority = SURFACE_PRIORITY[surface];
  if (priority.length === 0) return ids;
  const rank = new Map(priority.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return ids.indexOf(a) - ids.indexOf(b);
  });
}
