import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";

interface CancelOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: (reason: string) => void;
}

/**
 * Confirmation step for the real Order domain's confirmed -> cancelled (and
 * draft -> cancelled) lifecycle transition. Stock restoration happens only
 * inside transitionOrderLifecycleFn's backend transaction (migration 026) —
 * this sheet only collects an optional reason and calls onConfirm.
 */
export function CancelOrderSheet({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: CancelOrderSheetProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

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
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor="cancel-order-reason" className="text-label text-text-secondary">
          {t("order.cancelSheet.reason")}
        </Label>
        <Input
          id="cancel-order-reason"
          className="h-12"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Button
        className="tap-target mt-5 h-12 w-full"
        variant="destructive"
        disabled={pending}
        onClick={() => onConfirm(reason)}
      >
        {pending ? t("order.cancelling") : t("order.cancelSheet.submit")}
      </Button>
    </BottomSheet>
  );
}
