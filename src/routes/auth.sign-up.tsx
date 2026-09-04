import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth/sign-up")({
  head: () => ({
    meta: [{ title: "Create account — APSA" }],
  }),
  component: SignUp,
});

const schema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    confirmPassword: z.string().min(1),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

function SignUp() {
  const { t } = useTranslation();
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const { error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
    });
    if (error) {
      setServerError(error.message);
    } else {
      setSubmitted(values.email);
    }
  }

  if (submitted) {
    return (
      <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary p-6 text-center">
        <div className="mb-4 text-4xl" role="img" aria-label="Email">
          📬
        </div>
        <h2 className="text-h2 text-text-primary">{t("auth.signUp.success")}</h2>
        <p className="mt-2 text-body-sm text-text-secondary">
          {t("auth.signUp.successBody", { email: submitted })}
        </p>
        <Link
          to="/auth/sign-in"
          className="mt-6 block text-body-sm font-medium text-action-primary hover:underline"
        >
          {t("auth.signIn.title")}
        </Link>
      </div>
    );
  }

  return (
    <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary p-6">
      <h2 className="text-h2 text-text-primary">{t("auth.signUp.title")}</h2>
      <p className="mt-1 text-body-sm text-text-secondary">{t("auth.signUp.subtitle")}</p>

      <form onSubmit={(e) => { void handleSubmit(onSubmit)(e); }} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("auth.signUp.email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            aria-invalid={!!errors.email}
            {...register("email")}
          />
          {errors.email && (
            <p className="text-caption text-feedback-error" role="alert">
              {errors.email.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">{t("auth.signUp.password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            {...register("password")}
          />
          {errors.password && (
            <p className="text-caption text-feedback-error" role="alert">
              {errors.password.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">{t("auth.signUp.confirmPassword")}</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.confirmPassword}
            {...register("confirmPassword")}
          />
          {errors.confirmPassword && (
            <p className="text-caption text-feedback-error" role="alert">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        {serverError && (
          <p className="text-caption text-feedback-error" role="alert">
            {serverError}
          </p>
        )}

        <Button type="submit" className="tap-target w-full" disabled={isSubmitting}>
          {isSubmitting ? t("common.loading") : t("auth.signUp.submit")}
        </Button>
      </form>

      <p className="mt-6 text-center text-body-sm text-text-secondary">
        {t("auth.signUp.hasAccount")}{" "}
        <Link to="/auth/sign-in" className="font-medium text-action-primary hover:underline">
          {t("auth.signUp.signIn")}
        </Link>
      </p>
    </div>
  );
}
