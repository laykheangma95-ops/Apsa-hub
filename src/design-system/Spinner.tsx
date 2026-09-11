import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  className?: string;
}

/**
 * The one busy indicator for actions in flight.
 *
 * It is always paired with words — "Confirming…", "Signing out…" — so the
 * state never rests on motion alone, and the global prefers-reduced-motion
 * block stills the spin while the words keep the state honest. Decorative
 * by itself, therefore aria-hidden: the button's own text and aria-busy
 * carry the meaning.
 */
export function Spinner({ className }: SpinnerProps) {
  return <Loader2 aria-hidden className={cn("size-4 shrink-0 animate-spin", className)} />;
}
