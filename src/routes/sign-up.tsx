/**
 * Create account.
 *
 * Presentation only — signUpFn on the server creates the auth user and decides
 * whether email verification is required. This screen never writes to the
 * database and never issues a session itself.
 *
 * Shares the mobile contract documented on sign-in.tsx: dvh framing, 44px
 * controls, and a route in both directions of the account journey.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { signUpFn } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/design-system";
import i18n, { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/sign-up")({
  head: () => ({
    meta: [{ title: i18n.t("auth.signUp.head.title") }],
  }),
  component: SignUpPage,
});

function SignUpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Double-submit guard: one account per tap, whatever the network does.
    if (loading) return;

    setError(null);
    setLoading(true);

    try {
      const result = await signUpFn({
        data: {
          displayName: displayName.trim(),
          email: email.trim(),
          password,
        },
      });

      if (!result.ok) {
        if (result.code === "weak_password") {
          // The server owns the password policy and says which rule failed.
          setError(result.message);
        } else if (result.code === "email_taken") {
          setError(t("auth.signUp.errors.emailTaken"));
        } else {
          setError(result.message || t("auth.signUp.errors.generic"));
        }
        return;
      }

      await navigate({ to: result.emailVerificationRequired ? "/verify-email" : "/onboarding" });
    } catch {
      setError(t("auth.signUp.errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-h3 font-semibold text-action-primary">{t("brand.name")}</p>
          <h1 className="text-h1 mt-3 text-text-primary">{t("auth.signUp.title")}</h1>
          <p className="text-body-sm mt-1 text-text-secondary">{t("auth.signUp.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="name">{t("auth.signUp.nameLabel")}</Label>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              required
              autoFocus
              className="min-h-11"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t("auth.signUp.namePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">{t("auth.signUp.emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              required
              className="min-h-11"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("auth.signUp.emailPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">{t("auth.signUp.passwordLabel")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="min-h-11"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.signUp.passwordPlaceholder")}
            />
          </div>

          {error ? (
            <p role="alert" className="text-body-sm text-status-danger-text">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="min-h-11 w-full" disabled={loading} aria-busy={loading}>
            {loading ? (
              <>
                <Spinner className="size-4" />
                {t("auth.signUp.submitting")}
              </>
            ) : (
              t("auth.signUp.submit")
            )}
          </Button>
        </form>

        <p className="text-body-sm text-center text-text-secondary">
          {t("auth.signUp.haveAccount")}{" "}
          <Link
            to="/sign-in"
            className="tap-target inline-flex items-center font-medium text-action-primary underline underline-offset-4"
          >
            {t("auth.signUp.signIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
