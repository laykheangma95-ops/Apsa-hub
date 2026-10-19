import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BottomSheet, Spinner } from "@/design-system";

interface CompleteOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}

/**
 * Confirmation step for confirmed -> completed. Completing is terminal: the
 * order can no longer be cancelled or re-labelled. It moves no stock and no
 * money, and the database refuses it unless the order is paid AND fulfilled —
 * this sheet only asks the merchant to confirm before calling onConfirm.
 */
export function CompleteOrderSheet({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: CompleteOrderSheetProps) {
  const { t } = useTranslation();
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("order.completeSheet.title")}
      snap="half"
    >
      <p className="text-body-sm text-text-secondary">{t("order.completeSheet.body")}</p>
      <Button
        className="tap-target mt-5 h-auto min-h-12 w-full whitespace-normal"
        disabled={pending}
        aria-busy={pending}
        onClick={onConfirm}
      >
        {pending ? <Spinner /> : null}
        {pending ? t("order.completing") : t("order.completeSheet.submit")}
      </Button>
    </BottomSheet>
  );
}
