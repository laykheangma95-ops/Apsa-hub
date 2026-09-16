/**
 * Email verification waiting room.
 *
 * The /app and /onboarding guards redirect a signed-up member here whenever
 * their email is not confirmed yet, so this is a route real merchants land on
 * — it was previously a one-line "coming soon" stub with no explanation and no
 * way out, which stranded them mid-signup.
 *
 * This screen is presentation only. It sends no mail and grants nothing: the
 * confirmation link in the merchant's inbox is the only thing that verifies an
 * address, and checkAppGuardFn on the server is the only thing that decides
 * whether they may continue. "I have confirmed — continue" simply re-enters
 * /app so that server guard runs again; if the address is still unconfirmed,
 * the guard sends them straight back here.
 *
 * Resending the confirmation mail needs a server function that does not exist
 * yet — recorded as deferred backend work rather than faked here.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/design-system";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/verify-email")({
  head: () => ({
    meta: [{ title: "Check your email — APSA" }],
  }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);

  async function handleContinue() {
    if (checking) return;
    setChecking(true);
    try {
      // The server guard on /app decides. If the address is still
      // unconfirmed it redirects back here, which is the honest answer.
      await navigate({ to: "/app" });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6 text-center">
        <span
          aria-hidden
          className="mx-auto flex size-14 items-center justify-center rounded-full bg-action-primary-soft text-action-primary"
        >
          <MailCheck className="size-7" />
        </span>

        <div>
          <h1 className="text-h1 text-text-primary">{t("auth.verifyEmail.title")}</h1>
          <p className="text-body-sm mt-2 text-text-secondary">{t("auth.verifyEmail.subtitle")}</p>
          <p className="text-caption mt-3 text-text-muted">{t("auth.verifyEmail.hint")}</p>
        </div>

        <div className="space-y-3">
          <Button
            type="button"
            className="min-h-11 w-full"
            onClick={handleContinue}
            disabled={checking}
            aria-busy={checking}
          >
            {checking ? <Spinner className="size-4" /> : null}
            {t("auth.verifyEmail.continueAction")}
          </Button>

          <Link
            to="/sign-in"
            className="text-body-sm tap-target inline-flex w-full items-center justify-center font-medium text-text-secondary underline underline-offset-4"
          >
            {t("auth.verifyEmail.backToSignIn")}
          </Link>
        </div>
      </div>
    </div>
  );
}
