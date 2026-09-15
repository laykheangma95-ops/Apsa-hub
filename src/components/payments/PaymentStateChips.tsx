/**
 * The three payment axes, drawn as three separate chips that never merge.
 *
 * The Payment domain models settlement (`status`), trust (`verification_state`)
 * and refunds as INDEPENDENT facts, and collapsing them into one badge is
 * exactly the ambiguity CORRECTIONS.md and the Payment domain exist to
 * prevent: "Paid · Needs review" and "Paid · Bank verified" are different
 * situations, and a payment that was refunded is still a payment that was
 * paid. So each axis gets its own chip, with its own label.
 *
 * Settlement reuses the shared design-system StatusChip (pending / paid /
 * failed / reversed / refunded are all StatusKeys). Verification does not:
 * it is a different question with a different vocabulary, and folding
 * "mismatch" into the same component that renders order and delivery statuses
 * would make it read as another settlement outcome. It follows the same
 * grammar instead — soft token background, its own icon, a written label,
 * never colour alone, and `chip-text` so a Khmer label wraps rather than
 * clipping.
 */
import {
  AlertTriangle,
  Banknote,
  CircleHelp,
  Copy,
  Landmark,
  QrCode,
  ShieldCheck,
  Truck,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusChip } from "@/design-system";
import { cn } from "@/lib/utils";
import type { PaymentMethod, PaymentStatus, PaymentVerificationState } from "@/lib/payments";
import type { StatusKey } from "@/types";

type Tone = "info" | "success" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  info: "bg-status-info-soft text-status-info-text",
  success: "bg-status-success-soft text-status-success-text",
  warning: "bg-status-warning-soft text-status-warning-text",
  danger: "bg-status-danger-soft text-status-danger-text",
  neutral: "bg-surface-secondary text-text-secondary",
};

const VERIFICATION_MAP: Record<PaymentVerificationState, { tone: Tone; icon: LucideIcon }> = {
  unverified: { tone: "neutral", icon: CircleHelp },
  staff_confirmed: { tone: "info", icon: UserCheck },
  manager_verified: { tone: "info", icon: ShieldCheck },
  bank_verified: { tone: "success", icon: Landmark },
  mismatch: { tone: "danger", icon: AlertTriangle },
  duplicate_suspected: { tone: "warning", icon: Copy },
};

const METHOD_ICON: Record<PaymentMethod, LucideIcon> = {
  cash: Banknote,
  khqr: QrCode,
  bank_transfer: Landmark,
  cod: Truck,
};

/**
 * Settlement axis. `status` is already a StatusKey for every payment status —
 * `reversed` was added to that vocabulary alongside the Payment domain.
 */
export function PaymentStatusChip({
  status,
  size = "sm",
}: {
  status: PaymentStatus;
  size?: "sm" | "md";
}) {
  return <StatusChip status={status as StatusKey} size={size} />;
}

/** Trust axis. Never implies the money settled — that is the status chip's job. */
export function PaymentVerificationChip({
  state,
  className,
}: {
  state: PaymentVerificationState;
  className?: string;
}) {
  const { t } = useTranslation();
  const { tone, icon: Icon } = VERIFICATION_MAP[state];

  return (
    <span
      className={cn(
        "text-label inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="chip-text">{t(`payments.verification.${state}`)}</span>
    </span>
  );
}

/**
 * How the money was claimed to have arrived. COD is styled exactly like every
 * other method and carries no settlement colour: a cash-on-delivery payment
 * record is a collection arrangement, never a statement that money arrived.
 */
export function PaymentMethodChip({
  method,
  className,
}: {
  method: PaymentMethod;
  className?: string;
}) {
  const { t } = useTranslation();
  const Icon = METHOD_ICON[method];

  return (
    <span
      className={cn(
        "text-label inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="chip-text">{t(`payments.method.${method}`)}</span>
    </span>
  );
}

/** "This one still needs a decision" — the same rule the server counts on Home. */
export function PaymentReviewChip({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <span
      className={cn(
        "text-label inline-flex max-w-full items-center gap-1.5 rounded-full bg-status-warning-soft px-2 py-0.5 text-status-warning-text",
        className,
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span className="chip-text">{t("payments.row.needsReview")}</span>
    </span>
  );
}
