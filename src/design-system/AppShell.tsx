import { motion, useReducedMotion } from "motion/react";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FeedbackToaster } from "./Feedback";

interface AppShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * The area a route belongs to: "/app/inbox/cv-1" and "/app/inbox" are one
 * place, "/app/pos" is another. Transitions fire between areas, not between a
 * list and its own detail — keying the animation on the full pathname
 * remounted the list every time a merchant opened a thread, which threw away
 * their scroll position and their place in the queue.
 */
function areaOf(pathname: string): string {
  return pathname.split("/").slice(0, 3).join("/");
}

/**
 * Shared signed-in mobile shell. Presentation only: it owns safe-area aware
 * framing, page transitions and the single feedback channel, never routing,
 * guards or data.
 */
export function AppShell({ children, className }: AppShellProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const reduceMotion = useReducedMotion();

  /*
   * The first paint is not a transition.
   *
   * An enter animation on the server-rendered markup means the whole app ships
   * as opacity:0 and stays invisible until JavaScript hydrates — measured at
   * ~700ms on a fast desktop in dev, and far worse on a mid-range phone. The
   * merchant sat looking at a blank screen while the content was already in
   * the document. Until mount there is nothing to animate from, so the first
   * render goes straight to its resting state; every route change after that
   * animates normally.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const animateEntry = mounted && !reduceMotion;

  return (
    <div
      className={cn(
        "min-h-dvh bg-surface-page text-text-primary [overscroll-behavior-y:contain]",
        className,
      )}
    >
      <motion.div
        key={areaOf(pathname)}
        initial={animateEntry ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: animateEntry ? 0.18 : 0, ease: [0.2, 0, 0, 1] }}
      >
        {children}
      </motion.div>
      <FeedbackToaster />
    </div>
  );
}
