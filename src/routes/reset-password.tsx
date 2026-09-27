/**
 * Reset password — landing page for the Supabase recovery email link, and
 * the "choose a new password" form.
 *
 * Presentation only. The link token is handed straight to
 * beginPasswordRecoveryFn, which exchanges it server-side and keeps the
 * recovery session in HttpOnly cookies this page never sees. The token is then
 * scrubbed from the address bar (replace navigation) so it does not linger in
 * history. completePasswordRecoveryFn changes the password, revokes every
 * session and clears all auth cookies — the member then signs in afresh. If
 * the global sign-out is not confirmed, the done state says so honestly
 * instead of claiming every device was signed out.
 *
 * Supported link shapes (see beginPasswordRecoveryFn):
 *   /reset-password?token_hash=…&type=recovery
 *   /reset-password?token=…&email=…&type=recovery
 * Supabase error redirects (?error_code=otp_expired …) land on the honest
 * invalid-link state with a way to request a new link.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import {
  beginPasswordRecoveryFn,
  completePasswordRecoveryFn,
  getPasswordRecoveryStatusFn,
} from "@/api/auth";
import { OperationalState } from "@/components/common/OperationalState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/design-system";
import { PASSWORD_MIN_LENGTH, validateNewPassword } from "@/lib/auth-recovery";
import i18n, { useTranslation } from "@/lib/i18n";

const resetPasswordSearchSchema = z.object({
  token_hash: z.string().optional(),
  token: z.string().optional(),
  email: z.string().optional(),
  type: z.string().optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  error_description: z.string().optional(),
});

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [{ title: i18n.t("auth.resetPassword.head.title") }],
  }),
  validateSearch: (search) => resetPasswordSearchSchema.parse(search),
  component: ResetPasswordPage,
});

type PageState =
  | { kind: "checking" }
  | { kind: "form" }
  | { kind: "invalid" }
  | { kind: "unavailable" }
  | { kind: "done"; otherSessionsRevoked: boolean };

function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [state, setState] = useState<PageState>({ kind: "checking" });
  const started = useRef(false);

  useEffect(() => {
    // The link token is single-use: never exchange it twice (React strict
    // mode re-runs effects in development).
    if (started.current) return;
    started.current = true;

    async function run() {
      try {
        if (search.error || search.error_code) {
          setState({ kind: "invalid" });
          return;
        }

        const linkInput = search.token_hash
          ? { tokenHash: search.token_hash }
          : search.token && search.email
            ? { token: search.token, email: search.email }
            : null;

        if (linkInput) {
          const result = await beginPasswordRecoveryFn({ data: linkInput });
          // Scrub the token from the address bar and history either way.
          await navigate({ to: "/reset-password", search: {}, replace: true });
          if (result.ok) setState({ kind: "form" });
          else setState({ kind: result.code === "invalid_link" ? "invalid" : "unavailable" });
          return;
        }

        const status = await getPasswordRecoveryStatusFn();
        setState({ kind: status.active ? "form" : "invalid" });
      } catch {
        setState({ kind: "unavailable" });
      }
    }

    void run();
    // Runs once per page load by design — see the guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6">
        {state.kind === "checking" ? (
          <div className="space-y-4 text-center">
            <p className="text-h3 font-semibold text-action-primary">{t("brand.name")}</p>
            <p className="text-body-sm text-text-secondary" role="status">
              {t("auth.resetPassword.checking")}
            </p>
            <Spinner className="mx-auto size-5" />
          </div>
        ) : null}

        {state.kind === "invalid" ? (
          <OperationalState
            title={t("auth.resetPassword.invalidTitle")}
            body={t("auth.resetPassword.invalidBody")}
            tone="danger"
            action={
              <Button asChild className="min-h-11 w-full">
                <Link to="/forgot-password">{t("auth.resetPassword.requestNewLink")}</Link>
              </Button>
            }
          />
        ) : null}

        {state.kind === "unavailable" ? (
          <OperationalState
            title={t("auth.resetPassword.unavailableTitle")}
            body={t("auth.resetPassword.unavailableBody")}
            tone="danger"
            action={
              <Button asChild className="min-h-11 w-full">
                <Link to="/forgot-password">{t("auth.resetPassword.requestNewLink")}</Link>
              </Button>
            }
          />
        ) : null}

        {state.kind === "done" ? (
          <div className="space-y-6 text-center">
            <span
              aria-hidden
              className="mx-auto flex size-14 items-center justify-center rounded-full bg-status-success-soft text-status-success-text"
            >
              <CheckCircle2 className="size-7" />
            </span>
            <div role="status">
              <h1 className="text-h1 text-text-primary">{t("auth.resetPassword.doneTitle")}</h1>
              <p className="text-body-sm mt-2 text-text-secondary">
                {state.otherSessionsRevoked
                  ? t("auth.resetPassword.doneBody")
                  : t("auth.resetPassword.doneBodyUnconfirmedSignOut")}
              </p>
            </div>
            <Button asChild className="min-h-11 w-full">
              <Link to="/sign-in">{t("auth.resetPassword.goToSignIn")}</Link>
            </Button>
          </div>
        ) : null}

        {state.kind === "form" ? (
          <NewPasswordForm
            onDone={(otherSessionsRevoked) => setState({ kind: "done", otherSessionsRevoked })}
            onExpired={() => setState({ kind: "invalid" })}
          />
        ) : null}
      </div>
    </div>
  );
}

function NewPasswordForm({
  onDone,
  onExpired,
}: {
  onDone: (otherSessionsRevoked: boolean) => void;
  onExpired: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (loading) return;

    const issue = validateNewPassword(password, confirmPassword);
    if (issue) {
      setError(
        issue === "mismatch"
          ? t("auth.resetPassword.errors.mismatch")
          : issue === "too_short"
            ? t("auth.resetPassword.errors.tooShort", { min: PASSWORD_MIN_LENGTH })
            : t("auth.resetPassword.errors.tooLong"),
      );
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const result = await completePasswordRecoveryFn({ data: { password, confirmPassword } });
      if (result.ok) {
        onDone(result.otherSessionsRevoked);
        return;
      }
      if (result.code === "recovery_expired") {
        onExpired();
        return;
      }
      setError(
        result.code === "weak_password"
          ? t("auth.resetPassword.errors.weak")
          : result.code === "same_password"
            ? t("auth.resetPassword.errors.samePassword")
            : t("auth.resetPassword.errors.generic"),
      );
    } catch {
      setError(t("auth.resetPassword.errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="text-center">
        <p className="text-h3 font-semibold text-action-primary">{t("brand.name")}</p>
        <h1 className="text-h1 mt-3 text-text-primary">{t("auth.resetPassword.title")}</h1>
        <p className="text-body-sm mt-1 text-text-secondary">
          {t("auth.resetPassword.subtitle", { min: PASSWORD_MIN_LENGTH })}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">{t("auth.resetPassword.newPasswordLabel")}</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={PASSWORD_MIN_LENGTH}
            className="min-h-11"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "reset-password-error" : undefined}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">{t("auth.resetPassword.confirmPasswordLabel")}</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            className="min-h-11"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "reset-password-error" : undefined}
          />
        </div>

        {error ? (
          <p
            id="reset-password-error"
            role="alert"
            className="text-body-sm break-words text-status-danger-text"
          >
            {error}
          </p>
        ) : null}

        <Button type="submit" className="min-h-11 w-full" disabled={loading} aria-busy={loading}>
          {loading ? (
            <>
              <Spinner className="size-4" />
              {t("auth.resetPassword.submitting")}
            </>
          ) : (
            t("auth.resetPassword.submit")
          )}
        </Button>
      </form>
    </>
  );
}
