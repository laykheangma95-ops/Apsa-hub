import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { inboxSimulatorEnabled } from "@/simulator/inbox/gate";

/**
 * Development-only. `import.meta.env.DEV` is statically false in production
 * builds, so the dynamic import below is dead code there: the simulator
 * component, model and fixtures are not bundled at all. `beforeLoad` is the
 * runtime backstop (fail-closed) and runs before any simulator code loads.
 */
const InboxSimulator = import.meta.env.DEV
  ? lazy(() => import("@/simulator/inbox/InboxSimulator"))
  : null;

export const Route = createFileRoute("/design/inbox-simulator")({
  beforeLoad: () => {
    if (!InboxSimulator || !inboxSimulatorEnabled()) throw notFound();
  },
  head: () => ({ meta: [{ title: "Inbox simulator — APSA" }] }),
  component: () =>
    InboxSimulator ? (
      <Suspense fallback={null}>
        <InboxSimulator />
      </Suspense>
    ) : null,
});
