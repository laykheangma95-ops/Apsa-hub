import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { ApsiMark } from "./mascot/ApsiMark";

/** Bumped only if the navigation changes again — never to re-show the same tour. */
const STORAGE_KEY = "apsa.coach.nav.v1";

const STEPS = ["sales", "business", "apsi"] as const;

/**
 * Three cards, once, for merchants whose Orders button moved.
 *
 * This is the only thing in the app that is allowed to interrupt on arrival,
 * so it earns that by being short, skippable at any point, and gone forever
 * after — a tour that reappears is an apology that never ends. It sits above
 * the bar it is describing rather than over the middle of the screen, so a
 * merchant can look at the thing being named while reading about it.
 *
 * Nothing here is a gate: the app is fully usable underneath, and dismissing
 * costs nothing.
 */
export function NavCoachMarks() {
  const { t } = useTranslation();
  const newNav = useFeatureFlag("NEW_NAV_BAR");
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  /*
   * Starts closed and opens after mount. The server cannot know whether this
   * browser has already seen the tour, so rendering it during SSR would either
   * flash it at everybody or hide it from everybody.
   */
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!newNav) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      // Storage unavailable: show the tour rather than suppress it. Seeing it
      // twice is a smaller failure than never learning where Orders went.
    }
    setOpen(true);
  }, [newNav]);

  function finish() {
    setOpen(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Nothing to do — the tour simply may appear again on this device.
    }
  }

  if (!newNav) return null;

  const current = STEPS[step] ?? STEPS[0]!;
  const last = step === STEPS.length - 1;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="false"
          aria-label={t("appNav.coach.title")}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.2, 0, 0, 1] }}
          /* Clears the raised Apsi control, not just the bar: --nav-clearance
             stops at the hairline, and the circle stands proud of it. */
          className="fixed inset-x-0 bottom-[calc(var(--nav-clearance)+var(--apsi-button-raise)+0.5rem)] z-40 px-4"
        >
          <div className="glass-panel mx-auto flex max-w-[var(--screen-max)] items-start gap-3 rounded-2xl px-4 py-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-action-primary text-text-on-action">
              <ApsiMark size={20} />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-body text-text-primary">{t(`appNav.coach.${current}.title`)}</p>
              <p className="text-body-sm mt-0.5 text-text-secondary">
                {t(`appNav.coach.${current}.body`)}
              </p>

              <div className="mt-2.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => (last ? finish() : setStep(step + 1))}
                  className="press text-label rounded-full bg-action-primary px-4 py-2 text-text-on-action"
                >
                  {t(last ? "appNav.coach.done" : "appNav.coach.next")}
                </button>
                <span className="text-caption tnum text-text-muted">
                  {t("appNav.coach.progress", { step: step + 1, total: STEPS.length })}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={finish}
              aria-label={t("appNav.coach.skip")}
              className="press tap-target -mt-1 -mr-2 flex shrink-0 items-center justify-center rounded-full text-text-muted"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
