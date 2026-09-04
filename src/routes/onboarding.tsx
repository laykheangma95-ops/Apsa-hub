/**
 * Founder onboarding — organization creation.
 *
 * Security design:
 *   - beforeLoad runs the same server guard as /app (checkAppGuardFn), so an
 *     unauthenticated or unverified visitor never renders this page.
 *   - Submission goes through createOrganizationFn (a server function). The
 *     founder identity comes from the validated session cookie; no user_id or
 *     organization_id is ever sent from the browser.
 *   - Organization creation happens only inside create_organization_for_founder
 *     (migration 009). This page performs no inserts and no slug availability
 *     query — the DB constraint organizations_slug_unique is the sole authority.
 *   - Client-side validation is a UX affordance only; the server re-validates.
 */
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { checkAppGuardFn } from "@/api/app-guard";
import { createOrganizationFn, slugSchema } from "@/api/org";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApsiIllustration } from "@/design-system";
import { useTranslation } from "@/lib/i18n";
import { slugify } from "@/lib/slug";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [{ title: "Create your business - APSA" }],
  }),

  // Server-side guard. Never move this into an effect: that would flash the
  // form to signed-out visitors before redirecting.
  beforeLoad: async () => {
    const result = await checkAppGuardFn();

    // Already a member of an active organization — onboarding is done.
    if (result.ok) throw redirect({ to: "/app" });

    // Not signed in / not verified / access revoked.
    if (result.redirect !== "/onboarding") throw redirect({ to: result.redirect });
  },

  component: OnboardingPage,
});

type FieldErrors = {
  name?: string;
  slug?: string;
};

function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(value: string) {
    setName(value);
    // Suggest a slug until the founder takes control of the field.
    if (!slugEdited) setSlug(slugify(value));
  }

  function handleSlugChange(value: string) {
    setSlugEdited(true);
    setSlug(value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Double-submit guard: one organization per founder, one request at a time.
    if (submitting) return;

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();

    const nextFieldErrors: FieldErrors = {};
    if (trimmedName.length === 0) {
      nextFieldErrors.name = t("onboarding.errors.nameRequired");
    }
    if (trimmedSlug.length === 0) {
      nextFieldErrors.slug = t("onboarding.errors.slugRequired");
    } else if (!slugSchema.safeParse(trimmedSlug).success) {
      // Format only. Availability is decided by the database, never here.
      nextFieldErrors.slug = t("onboarding.errors.slugFormat");
    }

    setFormError(null);
    setFieldErrors(nextFieldErrors);
    if (nextFieldErrors.name || nextFieldErrors.slug) return;

    setSubmitting(true);

    try {
      const result = await createOrganizationFn({
        data: {
          legalName: trimmedName,
          displayName: trimmedName,
          slug: trimmedSlug,
        },
      });

      if (result.ok) {
        await navigate({ to: "/app" });
        return;
      }

      switch (result.code) {
        case "slug_taken":
          setFieldErrors({ slug: t("onboarding.errors.slugTaken") });
          return;

        case "invalid_slug":
        case "invalid_input":
          setFieldErrors({ slug: t("onboarding.errors.slugFormat") });
          return;

        case "already_member":
          // The founder already owns an organization — send them into the app.
          await navigate({ to: "/app" });
          return;

        case "unauthenticated":
          await navigate({ to: "/sign-in" });
          return;

        case "email_not_verified":
          await navigate({ to: "/verify-email" });
          return;

        default:
          setFormError(t("onboarding.errors.generic"));
          return;
      }
    } catch {
      setFormError(t("onboarding.errors.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center text-center">
          <ApsiIllustration pose="waving" size={88} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
            {t("onboarding.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("onboarding.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="organization-name">{t("onboarding.nameLabel")}</Label>
            <Input
              id="organization-name"
              name="organizationName"
              autoComplete="organization"
              autoFocus
              required
              value={name}
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder={t("onboarding.namePlaceholder")}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={
                fieldErrors.name ? "organization-name-error" : "organization-name-hint"
              }
            />
            {fieldErrors.name ? (
              <p id="organization-name-error" role="alert" className="text-sm text-destructive">
                {fieldErrors.name}
              </p>
            ) : (
              <p id="organization-name-hint" className="text-sm text-muted-foreground">
                {t("onboarding.nameHint")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="organization-slug">{t("onboarding.slugLabel")}</Label>
            <Input
              id="organization-slug"
              name="organizationSlug"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              required
              value={slug}
              onChange={(event) => handleSlugChange(event.target.value)}
              placeholder={t("onboarding.slugPlaceholder")}
              aria-invalid={fieldErrors.slug ? true : undefined}
              aria-describedby={
                fieldErrors.slug ? "organization-slug-error" : "organization-slug-hint"
              }
            />
            {fieldErrors.slug ? (
              <p id="organization-slug-error" role="alert" className="text-sm text-destructive">
                {fieldErrors.slug}
              </p>
            ) : (
              <p id="organization-slug-hint" className="text-sm text-muted-foreground">
                {t("onboarding.slugHint")}
              </p>
            )}
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
            {submitting ? t("onboarding.submitting") : t("onboarding.submit")}
          </Button>
        </form>
      </div>
    </div>
  );
}
