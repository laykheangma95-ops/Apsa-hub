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
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, MailCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useTranslation } from "@/lib/i18n";
import { verifyEmailFn } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";
import { Spinner } from "@/design-system";

const verifyEmailSearchSchema = z.object({
  token: z.string().optional(),
  email: z.string().optional(),
  type: z.enum(["signup", "recovery", "invite"]).optional(),
});

export const Route = createFileRoute("/verify-email")({
  head: () => ({
    meta: [{ title: "Verify your email - APSA" }],
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

  const [state, setState] = useState<VerifyState>(
    token && email ? { kind: "verifying" } : { kind: "missing_params" },
  );

  useEffect(() => {
    if (!token || !email) return;

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
  }, [token, email, type]);

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
          <OperationalState
            title={t("verifyEmail.title")}
            body={t("verifyEmail.missingParams")}
            tone="danger"
            action={
              <Button asChild className="tap-target h-12 w-full">
                <Link to="/sign-up">{t("verifyEmail.backToSignUp")}</Link>
              </Button>
            }
          />
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
              <Button asChild className="tap-target h-12 w-full">
                <Link to="/sign-up">{t("verifyEmail.backToSignUp")}</Link>
              </Button>
            }
          />
        ) : null}
      </div>
    </div>
  );
}
