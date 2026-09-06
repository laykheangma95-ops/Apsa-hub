import { CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

/**
 * One feedback channel for the whole app.
 *
 * Before this, every screen invented its own confirmation: a `<p role="status">`
 * pinned to the top of a long scroll, invisible to a merchant who just tapped a
 * button at the bottom of the phone. Feedback now appears in the same place, in
 * the same shape, within thumb reach, and clears itself.
 *
 * Presentation only — it never decides whether an action succeeded.
 */

const TOAST_DURATION = 3200;

/** Confirms an action the merchant just took. Never used for passive info. */
export function notifySuccess(message: string, description?: string) {
  toast.success(message, {
    ...(description ? { description } : {}),
    duration: TOAST_DURATION,
    icon: <CheckCircle2 className="size-[18px] text-status-success" aria-hidden />,
  });
}

/** A failure the merchant needs to know about but that does not block the screen. */
export function notifyError(message: string, description?: string) {
  toast.error(message, {
    ...(description ? { description } : {}),
    duration: 5000,
    icon: <TriangleAlert className="size-[18px] text-status-danger" aria-hidden />,
  });
}

/** Neutral acknowledgement — a saved draft, a copied value. */
export function notifyInfo(message: string, description?: string) {
  toast(message, {
    ...(description ? { description } : {}),
    duration: TOAST_DURATION,
    icon: <Info className="size-[18px] text-action-primary" aria-hidden />,
  });
}
