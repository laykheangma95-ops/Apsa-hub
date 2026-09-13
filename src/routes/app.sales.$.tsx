import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveHubDeepLink } from "@/design-system/app-nav-config";

/**
 * New-IA aliases under /app/sales/*.
 *
 * The screens themselves did not move: /app/orders is still /app/orders, and
 * every bookmark, push notification and shared link that existed before this
 * navigation keeps working exactly as it did. What this route adds is the
 * other direction — now that merchants can see an IA with "Sales" in it, a URL
 * shaped like that IA (/app/sales/orders) resolves to the real screen instead
 * of a dead end.
 *
 * Resolved in beforeLoad, so the redirect happens on the server during SSR and
 * the merchant never sees a frame of the wrong screen. Anything unrecognised
 * lands on the hub itself rather than a 404: a link into Sales is a link into
 * Sales, and the hub is always a truthful answer to it.
 */
export const Route = createFileRoute("/app/sales/$")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: resolveHubDeepLink("sales", params._splat), replace: true });
  },
});
