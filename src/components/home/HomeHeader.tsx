import { ScanBarcode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LanguageToggle } from "@/design-system";
import { homeGreetingKey } from "@/lib/home-greeting";

interface HomeHeaderProps {
  /**
   * The business's own display name from the real Organization profile, or
   * null while it is unknown (loading, no organization.read, failed). Never a
   * fixture or a guess — without it the line simply carries the APSA mark.
   */
  businessName: string | null;
  /** Present only when this member may scan (see Home's canScan). */
  onScan?: (() => void) | undefined;
}

/**
 * Home's compact pinned bar: the APSA mark and the business on one small
 * line, the greeting under it, and the two controls Home actually has.
 *
 * Deliberately absent: a notification bell and a business switcher. Neither
 * has a backend (there is no notification feed, and no organization-switch
 * server function — see app.team.tsx), so offering either would be a control
 * that does nothing.
 */
export function HomeHeader({ businessName, onScan }: HomeHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="sticky top-0 z-30">
      <div className="glass-bar pad-safe-top border-b border-[var(--glass-border)] pb-2">
        <div className="mx-auto flex max-w-[var(--screen-max)] items-center gap-1 pr-2 pl-4">
          <div className="min-w-0 flex-1">
            <p className="text-caption flex min-w-0 items-center gap-1.5 text-text-secondary">
              <span className="shrink-0 font-semibold text-action-primary">{t("brand.name")}</span>
              {businessName ? (
                <>
                  <span aria-hidden className="size-1 shrink-0 rounded-full bg-border-strong" />
                  <span className="min-w-0 truncate">{businessName}</span>
                </>
              ) : null}
            </p>
            {/*
             * The hour is read on the Cambodia clock on both sides, so server
             * and client agree; the only possible difference is a render that
             * straddles 05:00/12:00/18:00, which is not worth a hydration error.
             */}
            <h1
              className="text-h3 truncate font-semibold text-text-primary"
              suppressHydrationWarning
            >
              {t(homeGreetingKey(new Date()))}
            </h1>
          </div>

          {onScan ? (
            <button
              type="button"
              onClick={onScan}
              aria-label={t("nav.scanBarcode")}
              className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full text-text-primary"
            >
              <ScanBarcode className="size-5" aria-hidden />
            </button>
          ) : null}

          <LanguageToggle className="text-text-primary" />
        </div>
      </div>
    </header>
  );
}
