import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ApsiIllustration, type ApsiPose } from "./ApsiIllustration";

interface ApsiInsightCardProps {
  title: string;
  body: string;
  pose?: ApsiPose;
  onDismiss?: () => void;
  className?: string;
}

/** Apsi speaks only where allowed: insight surfaces, empty states, onboarding. */
export function ApsiInsightCard({
  title,
  body,
  pose = "winking",
  onDismiss,
  className,
}: ApsiInsightCardProps) {
  const { t } = useTranslation();

  return (
    <aside
      className={cn(
        "relative flex items-start gap-3 rounded-2xl border border-action-primary-border bg-action-primary-soft p-3",
        className,
      )}
    >
      <ApsiIllustration pose={pose} size={44} />
      <div className="min-w-0 flex-1 pr-5">
        <p className="text-label text-text-primary">{title}</p>
        <p className="text-body-sm mt-0.5 text-text-secondary">{body}</p>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.dismiss")}
          className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full text-text-muted"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </aside>
  );
}
