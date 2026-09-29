import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { ParcelLabel } from "./ParcelLabel";
import { Spinner } from "@/design-system";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getParcelLabelData } from "@/lib/api";
import { buildParcelLabel, PARCEL_LABEL_SIZE_MM } from "@/lib/labels/parcel-label";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

/**
 * Parcel label preview + print (§13, §17). Accepts one or many order ids; each
 * order prints as its own 100×150 mm page (§17 bulk print).
 *
 * ── PII IS FAIL-CLOSED (§7 of the repair brief) ───────────────────────────────
 *
 * The label payload carries customer name, phone and delivery address. So:
 *   - the query key is partitioned by principal (userId + organizationId), never
 *     a bare ["parcel-labels", ids], so one member's label PII can never be
 *     served to another in the same tab; and
 *   - the fetch is gated on `canSensitive("fulfillment.print_label")` — the same
 *     capability the server requires — read fail-closed: a pending or
 *     refresh-failed snapshot does not fetch, and a denied member sees the
 *     refusal state, never a label. FulfillmentSensitiveCacheGuard evicts any
 *     cached label PII the instant that capability stops holding.
 */
export interface ParcelLabelDialogProps {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
  /** From the /app route guard's server-derived context. */
  userId: string;
  /** From the /app route guard's server-derived context. */
  organizationId: string;
}

export function ParcelLabelDialog({
  open,
  onClose,
  orderIds,
  userId,
  organizationId,
}: ParcelLabelDialogProps) {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  // Fail-closed: canSensitive, not can — a pending/refresh-failed snapshot must
  // not fetch label PII, and this is the same key the server enforces.
  const canPrint = capabilities.canSensitive("fulfillment.print_label");

  const query = useQuery({
    // Principal-partitioned + sorted id set (see fulfillmentKeys.parcelLabels).
    queryKey: fulfillmentKeys.parcelLabels(userId, organizationId, orderIds),
    queryFn: () => Promise.all(orderIds.map((id) => getParcelLabelData(id))),
    enabled: open && orderIds.length > 0 && canPrint,
  });

  if (!open) return null;

  const title =
    orderIds.length > 1
      ? t("labels.parcel.bulkTitle", { count: orderIds.length })
      : t("labels.parcel.title");

  return (
    <LabelSheet open={open} onClose={onClose} title={title} pageSize={PARCEL_LABEL_SIZE_MM}>
      {!canPrint ? (
        <div className="flex h-full items-center justify-center p-[6mm] text-center text-[10pt] text-black">
          {t("labels.parcel.denied")}
        </div>
      ) : query.isPending ? (
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
