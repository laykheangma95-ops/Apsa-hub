import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { useLanguage } from "@/lib/i18n";

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
});

function AuthLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();

  // Redirect authenticated users away from auth pages
  useEffect(() => {
    if (!loading && user) {
      void navigate({ to: "/app" });
    }
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-page">
        <p className="text-body text-text-secondary">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface-page">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <h1 className="text-h1 text-text-primary">{t("brand.name")}</h1>
            <p className="mt-1 text-body-sm text-text-secondary">{t("brand.tagline")}</p>
          </div>
          <Outlet />
        </div>
      </div>

      <footer className="pb-safe flex items-center justify-center gap-4 px-4 py-4">
        <button
          type="button"
          onClick={() => setLanguage("km")}
          className={`text-caption ${language === "km" ? "font-medium text-text-primary" : "text-text-secondary"}`}
        >
          {t("common.khmer")}
        </button>
        <span className="text-border-default">·</span>
        <button
          type="button"
          onClick={() => setLanguage("en")}
          className={`text-caption ${language === "en" ? "font-medium text-text-primary" : "text-text-secondary"}`}
        >
          {t("common.english")}
        </button>
      </footer>
    </div>
  );
}
