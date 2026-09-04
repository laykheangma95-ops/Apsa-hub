import { createFileRoute } from "@tanstack/react-router";
import { AppHeader, AppShell, BottomNav } from "@/design-system";

export const Route = createFileRoute("/shell-preview")({ component: P });

function P() {
  return (
    <AppShell>
      <AppHeader title="APSA" subtitle="Phnom Penh" notificationCount={3} />
      <main className="px-4 py-4 pb-[var(--space-nav-clearance)]">
        {Array.from({ length: 20 }).map((_, i) => (
          <p key={i} className="text-body py-3">Row {i}</p>
        ))}
      </main>
      <BottomNav workspace="business" />
    </AppShell>
  );
}
