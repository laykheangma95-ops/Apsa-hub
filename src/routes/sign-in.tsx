/**
 * Sign in.
 *
 * Presentation only — every authorization decision stays in signInFn on the
 * server, which owns the session cookie and decides where the member lands.
 * This screen never inspects or stores a token.
 *
 * Mobile contract (see the launch-readiness mobile audit):
 *   - `min-h-dvh`, not `min-h-screen`: on a phone `vh` is measured against the
 *     tallest possible viewport, so the card sat under the browser chrome and
 *     the submit button could be below the fold on a short screen.
 *   - Every control clears 44px. The shadcn defaults are 36px, which is under
 *     the touch target the rest of APSA holds itself to.
 *   - Both directions of the account journey are reachable from here. This
 *     screen previously had no route to sign-up at all, so a new merchant who
 *     landed on it was stuck.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { signInFn } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/design-system";
import i18n, { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/sign-in")({
  head: () => ({
    meta: [{ title: i18n.t("auth.signIn.head.title") }],
  }),
  component: SignInPage,
});

function SignInPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (loading) return;

    setError(null);
    setLoading(true);

    try {
      const result = await signInFn({
        data: {
          email: email.trim(),
          password,
        },
      });

      if (!result.ok) {
        setError(
          result.code === "invalid_credentials"
            ? t("auth.signIn.errors.invalidCredentials")
            : result.message || t("auth.signIn.errors.generic"),
        );
        return;
      }

      await navigate({ to: result.redirectTo });
    } catch {
      setError(t("auth.signIn.errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-surface-page px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-h3 font-semibold text-action-primary">{t("brand.name")}</p>
          <h1 className="text-h1 mt-3 text-text-primary">{t("auth.signIn.title")}</h1>
          <p className="text-body-sm mt-1 text-text-secondary">{t("auth.signIn.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email">{t("auth.signIn.emailLabel")}</Label>
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
              placeholder={t("auth.signIn.emailPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">{t("auth.signIn.passwordLabel")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className="min-h-11"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.signIn.passwordPlaceholder")}
            />
          </div>

          {error ? (
            <p role="alert" className="text-body-sm text-status-danger-text">
              {error}
            </p>
          ) : null}

          {/*
            The pending state is carried by the spinner AND the word, never by
            the disabled colour alone — a merchant must be able to see that
            their tap was accepted before the server answers.
          */}
          <Button type="submit" className="min-h-11 w-full" disabled={loading} aria-busy={loading}>
            {loading ? (
              <>
                <Spinner className="size-4" />
                {t("auth.signIn.submitting")}
              </>
            ) : (
              t("auth.signIn.submit")
            )}
          </Button>
        </form>

        <p className="text-body-sm text-center text-text-secondary">
          {t("auth.signIn.noAccount")}{" "}
          <Link
            to="/sign-up"
            className="tap-target inline-flex items-center font-medium text-action-primary underline underline-offset-4"
          >
            {t("auth.signIn.createAccount")}
          </Link>
        </p>
      </div>
    </div>
  );
}
