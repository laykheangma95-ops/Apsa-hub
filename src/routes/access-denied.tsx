/**
 * Access revoked.
 *
 * The /app guard redirects here when a member's membership is suspended or
 * removed, so this is a route real people land on. It was previously an
 * untranslated stub with no way out; a member who reached it could neither
 * understand what had happened nor get back to sign in.
 *
 * Presentation only — it grants nothing and re-checks nothing. Whether the
 * member may enter is decided by checkAppGuardFn on the server.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/access-denied")({
  head: () => ({
    meta: [{ title: "Access paused — APSA" }],
  }),
  component: AccessDeniedPage,
});

function AccessDeniedPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6 text-center">
        <span
          aria-hidden
          className="mx-auto flex size-14 items-center justify-center rounded-full bg-status-warning-soft text-status-warning-text"
        >
          <ShieldAlert className="size-7" />
        </span>

        <div>
          <h1 className="text-h1 text-text-primary">{t("auth.accessDenied.title")}</h1>
          <p className="text-body-sm mt-2 text-text-secondary">{t("auth.accessDenied.subtitle")}</p>
          <p className="text-caption mt-3 text-text-muted">{t("auth.accessDenied.hint")}</p>
        </div>

        <Link
          to="/sign-in"
          className="text-body-sm tap-target inline-flex w-full items-center justify-center font-medium text-action-primary underline underline-offset-4"
        >
          {t("auth.accessDenied.backToSignIn")}
        </Link>
      </div>
    </div>
  );
}
