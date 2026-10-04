/**
 * Forgot password — request a reset link.
 *
 * Presentation only — requestPasswordResetFn on the server talks to Supabase
 * and answers identically whether or not the email has an account, so this
 * screen can only ever show the neutral "if an account exists…" message. It
 * never learns, and never shows, whether the address is registered.
 *
 * Shares the mobile contract documented on sign-in.tsx: dvh framing, 44px
 * controls, and a route back to sign-in.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { requestPasswordResetFn } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/design-system";
import { useCooldown } from "@/hooks/use-cooldown";
import { AUTH_EMAIL_COOLDOWN_SECONDS } from "@/lib/auth-recovery";
import { headTranslator, useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/forgot-password")({
  head: ({ match }) => ({
    meta: [{ title: headTranslator(match.context.language)("auth.forgotPassword.head.title") }],
  }),
  component: ForgotPasswordPage,
});

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const cooldown = useCooldown();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Double-submit guard: one request per tap, and none while cooling down.
    if (loading || cooldown.remaining > 0) return;

    const trimmed = email.trim();
    if (!EMAIL_SHAPE.test(trimmed)) {
      setError(t("auth.forgotPassword.errors.invalidEmail"));
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const result = await requestPasswordResetFn({ data: { email: trimmed } });
      if (!result.ok) {
        setError(t("auth.forgotPassword.errors.unavailable"));
        return;
      }
      setSent(true);
      cooldown.start(AUTH_EMAIL_COOLDOWN_SECONDS);
    } catch {
      setError(t("auth.forgotPassword.errors.unavailable"));
    } finally {
      setLoading(false);
    }
  }

  const coolingDown = cooldown.remaining > 0;

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-h3 font-semibold text-action-primary">{t("brand.name")}</p>
          <h1 className="text-h1 mt-3 text-text-primary">{t("auth.forgotPassword.title")}</h1>
          <p className="text-body-sm mt-1 text-text-secondary">
            {t("auth.forgotPassword.subtitle")}
          </p>
        </div>

        {sent ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-lg border border-border-default bg-surface-primary p-4"
          >
            <MailCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-action-primary" />
            <div className="min-w-0 space-y-1">
              <p className="text-body-sm font-medium text-text-primary">
                {t("auth.forgotPassword.sentTitle")}
              </p>
              <p className="text-body-sm break-words text-text-secondary">
                {t("auth.forgotPassword.sentBody")}
              </p>
            </div>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email">{t("auth.forgotPassword.emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              required
              autoFocus
              className="min-h-11"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("auth.forgotPassword.emailPlaceholder")}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "forgot-password-error" : undefined}
            />
          </div>

          {error ? (
            <p
              id="forgot-password-error"
              role="alert"
              className="text-body-sm break-words text-status-danger-text"
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={loading || coolingDown}
            aria-busy={loading}
          >
            {loading ? (
              <>
                <Spinner className="size-4" />
                {t("auth.forgotPassword.submitting")}
              </>
            ) : coolingDown ? (
              t("auth.forgotPassword.resendIn", { seconds: cooldown.remaining })
            ) : sent ? (
              t("auth.forgotPassword.resend")
            ) : (
              t("auth.forgotPassword.submit")
            )}
          </Button>
        </form>

        <p className="text-body-sm text-center text-text-secondary">
          <Link
            to="/sign-in"
            className="tap-target inline-flex items-center font-medium text-action-primary underline underline-offset-4"
          >
            {t("auth.forgotPassword.backToSignIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
