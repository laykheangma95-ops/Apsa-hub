/**
 * Email verification landing page.
 *
 * Reached from the Supabase confirmation email link, which carries the OTP
 * as `token` + `email` (+ optional `type`) query params — the exact shape
 * verifyEmailFn (src/api/auth.ts) already expects via client.auth.verifyOtp.
 * This page only wires the existing, already-working server function to a
 * UI; it does not change the verification contract.
 *
 * Error handling: the exchange is a network request and can fail for
 * reasons unrelated to the token (offline, a 5xx, a timeout) as well as for
 * an actually invalid/expired token — both are surfaced as a visible,
 * recoverable state, never an infinite spinner.
 *
 * Only email-verification link types (VERIFY_EMAIL_OTP_TYPES) are exchanged
 * here. A recovery link rewritten to /verify-email?…&type=recovery is shown
 * as an invalid link and never reaches the server: recovery tokens are handled
 * only by /reset-password, and never become a normal APSA session.
 *
 * Without a token (straight after sign-up, or sent here by the /app guard)
 * and after a failed link, the page offers a real resend through
 * resendVerificationFn. A signed-in, unverified member can only resend to
 * their own address; the server ignores any typed email in that case.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, MailCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import i18n, { useTranslation } from "@/lib/i18n";
import {
  getPendingVerificationFn,
  resendVerificationFn,
  VERIFY_EMAIL_OTP_TYPES,
  verifyEmailFn,
} from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCooldown } from "@/hooks/use-cooldown";
import { AUTH_EMAIL_COOLDOWN_SECONDS } from "@/lib/auth-recovery";
import { OperationalState } from "@/components/common/OperationalState";
import { Spinner } from "@/design-system";

const verifyEmailSearchSchema = z.object({
  token: z.string().optional(),
  email: z.string().optional(),
  type: z.string().optional(),
});

export const Route = createFileRoute("/verify-email")({
  head: () => ({
    meta: [{ title: i18n.t("verifyEmail.head.title") }],
  }),
  validateSearch: (search) => verifyEmailSearchSchema.parse(search),
  component: VerifyEmailPage,
});

type VerifyState =
  | { kind: "missing_params" }
  | { kind: "verifying" }
  | { kind: "success" }
  | { kind: "error"; code: "invalid_token" | "unexpected_error" };

function VerifyEmailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, email, type } = Route.useSearch();

  const typeAllowed = !type || (VERIFY_EMAIL_OTP_TYPES as readonly string[]).includes(type);

  const [state, setState] = useState<VerifyState>(
    !token || !email
      ? { kind: "missing_params" }
      : typeAllowed
        ? { kind: "verifying" }
        : { kind: "error", code: "invalid_token" },
  );

  useEffect(() => {
    if (!token || !email || !typeAllowed) return;

    let cancelled = false;

    async function run() {
      try {
        const result = await verifyEmailFn({
          data: { token: token!, email: email!, type: type ?? "signup" },
        });
        if (cancelled) return;

        if (result.ok) {
          setState({ kind: "success" });
          await navigate({ to: "/onboarding" });
          return;
        }

        setState({
          kind: "error",
          code: result.code === "invalid_token" ? "invalid_token" : "unexpected_error",
        });
      } catch {
        if (!cancelled) setState({ kind: "error", code: "unexpected_error" });
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, email, type, typeAllowed]);

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6 text-center">
        {state.kind === "verifying" || state.kind === "success" ? (
          <>
            <span
              aria-hidden
              className={
                state.kind === "success"
                  ? "mx-auto flex size-14 items-center justify-center rounded-full bg-status-success-soft text-status-success-text"
                  : "mx-auto flex size-14 items-center justify-center rounded-full bg-action-primary-soft text-action-primary"
              }
            >
              {state.kind === "success" ? (
                <CheckCircle2 className="size-7" />
              ) : (
                <MailCheck className="size-7" />
              )}
            </span>

            <div>
              <h1 className="text-h1 text-text-primary">{t("verifyEmail.title")}</h1>
              <p className="text-body-sm mt-2 text-text-secondary" role="status">
                {state.kind === "success" ? t("verifyEmail.success") : t("verifyEmail.verifying")}
              </p>
            </div>

            {state.kind === "verifying" ? <Spinner className="mx-auto size-5" /> : null}
          </>
        ) : null}

        {state.kind === "missing_params" ? (
          <>
            <span
              aria-hidden
              className="mx-auto flex size-14 items-center justify-center rounded-full bg-action-primary-soft text-action-primary"
            >
              <MailCheck className="size-7" />
            </span>
            <div>
              <h1 className="text-h1 text-text-primary">{t("verifyEmail.checkInboxTitle")}</h1>
              <p className="text-body-sm mt-2 text-text-secondary">
                {t("verifyEmail.checkInboxBody")}
              </p>
            </div>
            <ResendVerificationPanel initialEmail={email ?? ""} />
          </>
        ) : null}

        {state.kind === "error" ? (
          <OperationalState
            title={t("verifyEmail.title")}
            body={
              state.code === "invalid_token"
                ? t("verifyEmail.invalidToken")
                : t("verifyEmail.unexpectedError")
            }
            tone="danger"
            action={
              <Button asChild variant="outline" className="tap-target h-12 w-full">
                <Link to="/sign-up">{t("verifyEmail.backToSignUp")}</Link>
              </Button>
            }
          />
        ) : null}

        {state.kind === "error" && state.code === "invalid_token" ? (
          <ResendVerificationPanel initialEmail={email ?? ""} />
        ) : null}
      </div>
    </div>
  );
}

type ResendFeedback =
  | { kind: "sent" }
  | { kind: "error"; code: "rate_limited" | "service_unavailable" | "email_required" }
  | { kind: "already_verified" };

function ResendVerificationPanel({ initialEmail }: { initialEmail: string }) {
  const { t } = useTranslation();
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<ResendFeedback | null>(null);
  const cooldown = useCooldown();

  useEffect(() => {
    let cancelled = false;
    getPendingVerificationFn()
      .then((pending) => {
        if (!cancelled && pending) setPendingEmail(pending.email);
      })
      .catch(() => {
        // No signed-in member — the typed email is used instead.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Double-submit guard: one email per tap, and none while cooling down.
    if (loading || cooldown.remaining > 0) return;

    const typed = email.trim();
    if (!pendingEmail && !typed) {
      setFeedback({ kind: "error", code: "email_required" });
      return;
    }

    setFeedback(null);
    setLoading(true);

    try {
      const result = await resendVerificationFn({
        data: pendingEmail ? {} : { email: typed },
      });
      if (result.ok) {
        setFeedback({ kind: "sent" });
        cooldown.start(AUTH_EMAIL_COOLDOWN_SECONDS);
      } else if (result.code === "already_verified") {
        setFeedback({ kind: "already_verified" });
      } else {
        setFeedback({ kind: "error", code: result.code });
        if (result.code === "rate_limited") cooldown.start(AUTH_EMAIL_COOLDOWN_SECONDS);
      }
    } catch {
      // Includes a malformed email rejected by the server's validator.
      setFeedback({ kind: "error", code: "service_unavailable" });
    } finally {
      setLoading(false);
    }
  }

  const coolingDown = cooldown.remaining > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-left" noValidate>
      {pendingEmail ? (
        <p className="text-body-sm break-words text-text-secondary">
          {t("verifyEmail.resend.sendingTo", { email: pendingEmail })}
        </p>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="verify-email-address">{t("verifyEmail.resend.emailLabel")}</Label>
          <Input
            id="verify-email-address"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            required
            className="min-h-11"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("verifyEmail.resend.emailPlaceholder")}
          />
        </div>
      )}

      {feedback?.kind === "sent" ? (
        <p role="status" className="text-body-sm break-words text-status-success-text">
          {t("verifyEmail.resend.sent")}
        </p>
      ) : null}

      {feedback?.kind === "already_verified" ? (
        <p role="status" className="text-body-sm break-words text-text-secondary">
          {t("verifyEmail.resend.alreadyVerified")}{" "}
          <Link
            to="/sign-in"
            className="tap-target inline-flex items-center font-medium text-action-primary underline underline-offset-4"
          >
            {t("verifyEmail.resend.signIn")}
          </Link>
        </p>
      ) : null}

      {feedback?.kind === "error" ? (
        <p role="alert" className="text-body-sm break-words text-status-danger-text">
          {feedback.code === "rate_limited"
            ? t("verifyEmail.resend.rateLimited")
            : feedback.code === "email_required"
              ? t("verifyEmail.resend.emailRequired")
              : t("verifyEmail.resend.unavailable")}
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
            {t("verifyEmail.resend.submitting")}
          </>
        ) : coolingDown ? (
          t("verifyEmail.resend.cooldown", { seconds: cooldown.remaining })
        ) : (
          t("verifyEmail.resend.submit")
        )}
      </Button>

      <p className="text-body-sm text-center text-text-secondary">
        <Link
          to="/sign-in"
          className="tap-target inline-flex items-center font-medium text-action-primary underline underline-offset-4"
        >
          {t("verifyEmail.resend.backToSignIn")}
        </Link>
      </p>
    </form>
  );
}
