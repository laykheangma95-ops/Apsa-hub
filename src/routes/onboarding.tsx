/**
 * First-organization onboarding.
 *
 * This route is shown to authenticated users who have no active org membership.
 * It calls the server-side createOrganization function, passing the user's access
 * token. The server validates the token and creates the org atomically.
 *
 * Security invariants enforced server-side:
 * - userId derived from JWT, never from client body
 * - OWNER role applied server-side; client cannot choose their role
 * - org_id/slug uniqueness enforced server-side
 * - partial creation rolled back on any failure
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { createOrganization } from "@/server/org/create-organization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [{ title: "Set up your business — APSA" }],
  }),
  component: Onboarding,
});

const CURRENCIES = [
  { value: "KHR", label: "KHR — រៀល" },
  { value: "USD", label: "USD — US Dollar" },
];

const TIMEZONES = [
  { value: "Asia/Phnom_Penh", label: "Asia/Phnom_Penh (UTC+7)" },
  { value: "Asia/Bangkok", label: "Asia/Bangkok (UTC+7)" },
  { value: "Asia/Singapore", label: "Asia/Singapore (UTC+8)" },
  { value: "UTC", label: "UTC" },
];

const schema = z.object({
  displayName: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .transform((v) => v.toLowerCase()),
  defaultCurrency: z.string().length(3),
  timezone: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}

function Onboarding() {
  const { t } = useTranslation();
  const { user, session, loading } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  // Redirect unauthenticated visitors
  useEffect(() => {
    if (!loading && !user) {
      void navigate({ to: "/auth/sign-in", replace: true });
    }
  }, [user, loading, navigate]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      defaultCurrency: "KHR",
      timezone: "Asia/Phnom_Penh",
    },
  });

  // Auto-generate slug from business name
  const watchedName = watch("displayName");
  useEffect(() => {
    if (watchedName) {
      setValue("slug", slugify(watchedName), { shouldValidate: false });
    }
  }, [watchedName, setValue]);

  async function onSubmit(values: FormValues) {
    setServerError(null);
    if (!session) {
      setServerError(t("auth.signIn.error"));
      return;
    }

    try {
      await createOrganization({
        accessToken: session.access_token,
        displayName: values.displayName,
        slug: values.slug,
        defaultCurrency: values.defaultCurrency,
        country: "KH",
        timezone: values.timezone,
      });
      // Redirect into the app — membership now exists
      void navigate({ to: "/app", replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (message === "slug_taken") {
        setServerError(t("onboarding.slugTaken"));
      } else {
        setServerError(t("onboarding.error"));
      }
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-page">
        <p className="text-body text-text-secondary">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface-page">
      <div className="flex flex-1 flex-col items-center justify-start px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <h1 className="text-h1 text-text-primary">{t("onboarding.title")}</h1>
            <p className="mt-1 text-body-sm text-text-secondary">{t("onboarding.subtitle")}</p>
          </div>

          <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary p-6">
            <form
              onSubmit={(e) => {
                void handleSubmit(onSubmit)(e);
              }}
              className="space-y-5"
              noValidate
            >
              <div className="space-y-1.5">
                <Label htmlFor="displayName">{t("onboarding.businessName")}</Label>
                <Input
                  id="displayName"
                  type="text"
                  autoComplete="organization"
                  placeholder={t("onboarding.businessNamePlaceholder")}
                  aria-invalid={!!errors.displayName}
                  {...register("displayName")}
                />
                {errors.displayName && (
                  <p className="text-caption text-feedback-error" role="alert">
                    {errors.displayName.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="slug">{t("onboarding.businessSlug")}</Label>
                <div className="relative">
                  <Input
                    id="slug"
                    type="text"
                    autoCapitalize="none"
                    aria-invalid={!!errors.slug}
                    {...register("slug")}
                  />
                </div>
                <p className="text-caption text-text-secondary">
                  {t("onboarding.businessSlugHelp", { slug: watch("slug") || "your-business" })}
                </p>
                {errors.slug && (
                  <p className="text-caption text-feedback-error" role="alert">
                    {errors.slug.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="defaultCurrency">{t("onboarding.currency")}</Label>
                <select
                  id="defaultCurrency"
                  className="w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-body text-text-primary focus:outline-none focus:ring-2 focus:ring-action-primary"
                  aria-invalid={!!errors.defaultCurrency}
                  {...register("defaultCurrency")}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="timezone">{t("onboarding.timezone")}</Label>
                <select
                  id="timezone"
                  className="w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-body text-text-primary focus:outline-none focus:ring-2 focus:ring-action-primary"
                  aria-invalid={!!errors.timezone}
                  {...register("timezone")}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </div>

              {serverError && (
                <p className="text-caption text-feedback-error" role="alert">
                  {serverError}
                </p>
              )}

              <Button type="submit" className="tap-target w-full" disabled={isSubmitting}>
                {isSubmitting ? t("onboarding.creating") : t("onboarding.submit")}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
