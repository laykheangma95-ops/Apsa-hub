import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { isValidStaffReason } from "@/lib/order-work-queue";

interface CancelOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  /** Money has been recorded on this order: it is kept, never erased by cancelling. */
  paymentRecorded?: boolean;
  onConfirm: (reason: string) => void;
}

/**
 * Confirmation step for the real Order domain's confirmed -> cancelled (and
 * draft -> cancelled) lifecycle transition. Stock restoration happens only
 * inside transitionOrderLifecycleFn's backend transaction (migration 026), and
 * the custody guard (migration 063) refuses once the goods have left — this
 * sheet only collects the reason, which stays on the order's history, and calls
 * onConfirm. Cancelling never touches recorded payments; a refund is its own,
 * audited Payments action.
 */
export function CancelOrderSheet({
  open,
  onOpenChange,
  pending,
  paymentRecorded = false,
  onConfirm,
}: CancelOrderSheetProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const reasonOk = isValidStaffReason(reason);

  function handleOpenChange(next: boolean) {
    if (!next) setReason("");
    onOpenChange(next);
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={t("order.cancelSheet.title")}
      snap="half"
    >
      <p className="text-body-sm text-text-secondary">{t("order.cancelSheet.body")}</p>
      {paymentRecorded ? (
        <p className="text-body-sm mt-2 rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text">
          {t("order.cancelSheet.paymentKept")}
        </p>
      ) : null}
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor="cancel-order-reason" className="text-label text-text-secondary">
          {t("order.cancelSheet.reason")}
        </Label>
        <Input
          id="cancel-order-reason"
          className="h-12"
          value={reason}
          maxLength={500}
          aria-required="true"
          aria-describedby="cancel-order-reason-hint"
          onChange={(e) => setReason(e.target.value)}
        />
        <p id="cancel-order-reason-hint" className="text-caption text-text-muted">
          {t("order.cancelSheet.reasonHint")}
        </p>
      </div>
      <div className="mt-5 flex flex-col gap-2">
        <Button
          className="tap-target h-12 w-full"
          variant="destructive"
          disabled={pending || !reasonOk}
          onClick={() => onConfirm(reason.trim())}
        >
          {pending ? t("order.cancelling") : t("order.cancelSheet.submit")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="tap-target h-12 w-full"
          onClick={() => handleOpenChange(false)}
        >
          {t("order.cancelSheet.keep")}
        </Button>
      </div>
    </BottomSheet>
  );
}
