import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveHubDeepLink } from "@/design-system/app-nav-config";

/**
 * New-IA aliases under /app/business/*. See app.sales.$.tsx — same contract:
 * old paths are untouched, new-shaped paths resolve, unknown ones land on the
 * hub rather than a 404.
 */
export const Route = createFileRoute("/app/business/$")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: resolveHubDeepLink("business", params._splat), replace: true });
  },
});
