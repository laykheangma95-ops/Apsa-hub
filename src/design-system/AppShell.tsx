import { motion } from "motion/react";
import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * Shared signed-in mobile shell. Presentation only: it owns safe-area aware
 * framing and page transitions, never routing, guards or data.
 */
export function AppShell({ children, className }: AppShellProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div
      className={cn(
        "min-h-dvh bg-surface-page text-text-primary [overscroll-behavior-y:contain]",
        className,
      )}
    >
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      >
        {children}
      </motion.div>
    </div>
  );
}
