import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ApsiIllustration } from "./ApsiIllustration";

interface ErrorStateProps {
  title?: string;
  body?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title, body, onRetry, className }: ErrorStateProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)} role="alert">
      <ApsiIllustration pose="default" size={80} />
      <h3 className="text-h3 mt-4 text-text-primary">{title ?? t("error.title")}</h3>
      <p className="text-body mt-1 max-w-xs text-text-secondary">{body ?? t("error.body")}</p>
      {onRetry ? (
        <Button className="mt-4 tap-target" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}
