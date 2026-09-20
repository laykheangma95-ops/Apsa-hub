import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";

interface DeliveryReasonSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  title: string;
  body: string;
  reasonLabel: string;
  submitLabel: string;
  onConfirm: (reason: string) => void;
  /**
   * The server rejected the last submit — permission revoked mid-session, the
   * delivery already moved on, a network failure. Without this the sheet just
   * stopped spinning with the reason still typed in, and the merchant had no
   * way to tell the tap failed rather than the sheet simply not being ready.
   */
  error?: string | null;
}

/**
 * Shared reason-capture step for the two production Delivery transitions that
 * require a non-empty reason (src/api/deliveries.ts's reasonRequiredSchema):
 * cancel and fail. The server independently rejects an empty reason — this
 * sheet only disables submit early so the merchant isn't surprised by a 400.
 */
export function DeliveryReasonSheet({
  open,
  onOpenChange,
  pending,
  title,
  body,
  reasonLabel,
  submitLabel,
  onConfirm,
  error,
}: DeliveryReasonSheetProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  function handleOpenChange(next: boolean) {
    if (!next) setReason("");
    onOpenChange(next);
  }

  const trimmed = reason.trim();

  return (
    <BottomSheet open={open} onOpenChange={handleOpenChange} title={title} snap="half">
      <p className="text-body-sm text-text-secondary">{body}</p>
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor="delivery-reason" className="text-label text-text-secondary">
          {reasonLabel}
        </Label>
        <Input
          id="delivery-reason"
          className="h-12"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-body-sm mt-3 text-status-danger-text">
          {error}
        </p>
      ) : null}
      <Button
        className="tap-target mt-5 h-12 w-full"
        variant="destructive"
        disabled={pending || trimmed.length === 0}
        onClick={() => onConfirm(trimmed)}
      >
        {pending ? t("delivery.updating") : submitLabel}
      </Button>
    </BottomSheet>
  );
}
