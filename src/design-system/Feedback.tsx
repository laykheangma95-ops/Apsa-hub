import { Toaster as SonnerToaster } from "sonner";

/**
 * Mounted once at the app shell. Sits above the floating nav so a confirmation
 * never lands underneath it, and inside the safe area on iPhone.
 *
 * The notify* helpers that drive it live in `@/lib/feedback` — they are called
 * from event handlers, not rendered, and keeping them out of this module keeps
 * it component-only.
 */
export function FeedbackToaster() {
  return (
    <SonnerToaster
      position="bottom-center"
      offset="calc(var(--nav-clearance) + 0.5rem)"
      mobileOffset="calc(var(--nav-clearance) + 0.5rem)"
      visibleToasts={2}
      toastOptions={{
        classNames: {
          toast:
            "glass-panel !rounded-2xl !border-[color:var(--glass-border)] !text-text-primary !gap-3 !px-4 !py-3",
          title: "text-body !font-medium",
          description: "text-body-sm !text-text-secondary",
          actionButton: "!bg-action-primary !text-text-on-action !rounded-full",
          cancelButton: "!bg-surface-secondary !text-text-secondary !rounded-full",
        },
      }}
    />
  );
}
