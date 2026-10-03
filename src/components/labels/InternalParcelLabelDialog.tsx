import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { InternalParcelLabel } from "./InternalParcelLabel";
import { Spinner } from "@/design-system";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getInternalParcelLabelData } from "@/lib/api";
import {
  buildInternalParcelLabel,
  INTERNAL_PARCEL_LABEL_SIZE_MM,
} from "@/lib/labels/internal-parcel-label";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

/**
 * INTERNAL APSA Parcel label preview + print (CORRECTION-003). One or many
 * orders; each prints as its own 100×150 mm page.
 *
 * Always available for an order in fulfillment — before packing and with or
 * without a carrier shipment. The server returns the order's APSA Parcel
 * (created with confirmation) and its permanent code, so the label always shows the same identity on
 * every (re)print; this dialog never creates or chooses one. Nothing prints
 * unless every label in the batch carries its code.
 *
 * No customer PII is involved, so no sensitive reauthorization is needed; the
 * server still requires orders.read + fulfillment.print_label.
 */
export interface InternalParcelLabelDialogProps {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
  userId: string;
  organizationId: string;
}

export function InternalParcelLabelDialog({
  open,
  onClose,
  orderIds,
  userId,
  organizationId,
}: InternalParcelLabelDialogProps) {
  const { t } = useTranslation();
  const canPrint = useCapabilities().can("fulfillment.print_label");

  const query = useQuery({
    queryKey: fulfillmentKeys.internalLabels(userId, organizationId, orderIds),
    queryFn: () => Promise.all(orderIds.map((id) => getInternalParcelLabelData(id))),
    enabled: open && orderIds.length > 0 && canPrint,
  });

  if (!open) return null;

  const data = canPrint ? (query.data ?? []) : [];
  const allCoded = data.length > 0 && data.every((d) => !!d.parcelCode);
  const title =
    orderIds.length > 1
      ? t("labels.internal.bulkTitle", { count: orderIds.length })
      : t("labels.internal.dialogTitle");

  return (
    <LabelSheet
      open={open}
      onClose={onClose}
      title={title}
      pageSize={INTERNAL_PARCEL_LABEL_SIZE_MM}
      printable={canPrint && query.isSuccess && allCoded}
    >
      {!canPrint ? (
        <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
          {t("labels.internal.denied")}
        </div>
      ) : query.isPending ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : query.isError ? (
        <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
          {t("labels.internal.error")}
        </div>
      ) : (
        data.map((d) => <InternalParcelLabel key={d.order.id} vm={buildInternalParcelLabel(d)} />)
      )}
    </LabelSheet>
  );
}
