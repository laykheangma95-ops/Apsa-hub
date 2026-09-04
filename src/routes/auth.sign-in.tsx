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

export const Route = createFileRoute("/auth/sign-in")({
  head: () => ({
    meta: [{ title: "Sign in — APSA" }],
  }),
  component: SignIn,
});

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

function SignIn() {
  const { t } = useTranslation();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });
    if (error) {
      setServerError(t("auth.signIn.error"));
    }
    // On success, AuthProvider fires onAuthStateChange which triggers app.tsx guard redirect
  }

  return (
    <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary p-6">
      <h2 className="text-h2 text-text-primary">{t("auth.signIn.title")}</h2>
      <p className="mt-1 text-body-sm text-text-secondary">{t("auth.signIn.subtitle")}</p>

      <form onSubmit={(e) => { void handleSubmit(onSubmit)(e); }} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("auth.signIn.email")}</Label>
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
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t("auth.signIn.password")}</Label>
            <Link
              to="/auth/forgot-password"
              className="text-caption text-action-primary hover:underline"
            >
              {t("auth.signIn.forgot")}
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!errors.password}
            {...register("password")}
          />
          {errors.password && (
            <p className="text-caption text-feedback-error" role="alert">
              {errors.password.message}
            </p>
          )}
        </div>

        {serverError && (
          <p className="text-caption text-feedback-error" role="alert">
            {serverError}
          </p>
        )}

        <Button type="submit" className="tap-target w-full" disabled={isSubmitting}>
          {isSubmitting ? t("common.loading") : t("auth.signIn.submit")}
        </Button>
      </form>

      <p className="mt-6 text-center text-body-sm text-text-secondary">
        {t("auth.signIn.noAccount")}{" "}
        <Link to="/auth/sign-up" className="font-medium text-action-primary hover:underline">
          {t("auth.signIn.createAccount")}
        </Link>
      </p>
    </div>
  );
}
