import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => ({
    meta: [{ title: "New password — APSA" }],
  }),
  component: ResetPassword,
});

const schema = z
  .object({
    password: z.string().min(8),
    confirmPassword: z.string().min(1),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

function ResetPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const { error } = await supabase.auth.updateUser({ password: values.password });
    if (error) {
      setServerError(error.message);
    } else {
      await navigate({ to: "/auth/sign-in" });
    }
  }

  return (
    <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary p-6">
      <h2 className="text-h2 text-text-primary">{t("auth.resetPassword.title")}</h2>
      <p className="mt-1 text-body-sm text-text-secondary">{t("auth.resetPassword.subtitle")}</p>

      <form onSubmit={(e) => { void handleSubmit(onSubmit)(e); }} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t("auth.resetPassword.password")}</Label>
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
          <Label htmlFor="confirmPassword">{t("auth.resetPassword.confirmPassword")}</Label>
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
          {isSubmitting ? t("common.loading") : t("auth.resetPassword.submit")}
        </Button>
      </form>
    </div>
  );
}
