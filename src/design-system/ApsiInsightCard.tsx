import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Apsi, type ApsiEmotion } from "./mascot";

interface ApsiInsightCardProps {
  title: string;
  body: string;
  emotion?: ApsiEmotion;
  onDismiss?: () => void;
  className?: string;
}

/** Apsi speaks only where allowed: insight surfaces, empty states, onboarding. */
export function ApsiInsightCard({
  title,
  body,
  emotion = "thinking",
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
      <Apsi emotion={emotion} size="xs" withCompanion />
      <div className="min-w-0 flex-1 pr-5">
        <p className="text-label text-text-primary">{title}</p>
        <p className="text-body-sm mt-0.5 text-text-secondary">{body}</p>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.dismiss")}
          // A 24px icon needs a 44px target around it — the glyph stays small,
          // the thing a thumb has to hit does not.
          className="press tap-target absolute top-0.5 right-0.5 flex items-center justify-center rounded-full text-text-muted"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </aside>
  );
}
