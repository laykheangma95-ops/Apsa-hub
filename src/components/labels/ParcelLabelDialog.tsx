import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { ParcelLabel } from "./ParcelLabel";
import { Spinner } from "@/design-system";
import { getParcelLabelData } from "@/lib/api";
import { buildParcelLabel, PARCEL_LABEL_SIZE_MM } from "@/lib/labels/parcel-label";

/**
 * Parcel label preview + print (§13, §17). Accepts one or many order ids; each
 * order prints as its own 100×150 mm page (§17 bulk print). The data is fetched
 * from the PII-gated fulfillment endpoint — the server refuses a caller without
 * customers.view_sensitive, so an unauthorized member sees the error state, not a
 * label.
 */
export interface ParcelLabelDialogProps {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
}

export function ParcelLabelDialog({ open, onClose, orderIds }: ParcelLabelDialogProps) {
  const { t } = useTranslation();

  const query = useQuery({
    // Stable key across the exact set requested.
    queryKey: ["parcel-labels", [...orderIds].sort()],
    queryFn: () => Promise.all(orderIds.map((id) => getParcelLabelData(id))),
    enabled: open && orderIds.length > 0,
  });

  if (!open) return null;

  const title =
    orderIds.length > 1
      ? t("labels.parcel.bulkTitle", { count: orderIds.length })
      : t("labels.parcel.title");

  return (
    <LabelSheet open={open} onClose={onClose} title={title} pageSize={PARCEL_LABEL_SIZE_MM}>
      {query.isPending ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : query.isError ? (
        <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
          {t("labels.parcel.error")}
        </div>
      ) : (
        (query.data ?? []).map((data, i) => (
          <ParcelLabel key={orderIds[i] ?? i} vm={buildParcelLabel(data)} />
        ))
      )}
    </LabelSheet>
  );
}
