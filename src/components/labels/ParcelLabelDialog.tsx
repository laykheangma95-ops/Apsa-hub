import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { ParcelLabel } from "./ParcelLabel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/design-system";
import { ShippingDestinationSheet } from "@/components/orders/ShippingDestinationSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getParcelLabelData } from "@/lib/api";
import { buildParcelLabel, PARCEL_LABEL_SIZE_MM } from "@/lib/labels/parcel-label";
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

/**
 * Parcel label preview + print (§13, §17). Accepts one or many order ids; each
 * order prints as its own 100×150 mm page (§17 bulk print).
 *
 * ── ORDER-AUTHORITATIVE DESTINATION (§9, §13, migration 047) ──────────────────
 *
 * A label's destination is the ORDER's shipping snapshot, never the mutable
 * customer default. An order whose snapshot is not confirmed
 * (addressConfirmed === false) is NOT printable: the batch's Print button is
 * hidden and each such order shows a "Confirm shipping address" action that
 * captures the destination (updateOrderShipping). Only once every selected
 * order is confirmed does the batch print — so a first-time label can never go
 * out with an unverified address.
 *
 * ── CORRECTING A DESTINATION ──────────────────────────────────────────────────
 *
 * A wrong (already confirmed) destination is corrected through the same explicit
 * "Edit shipping address" action (updateOrderShipping → update_order_shipping_v1,
 * orders.update, refused once fulfillment is terminal, audited by field
 * presence). It rewrites only the ORDER's snapshot; the customer's default
 * address is never touched, and the label always reads the order's current
 * snapshot.
 *
 * ── PII IS FAIL-CLOSED (§12) ──────────────────────────────────────────────────
 *
 * The label payload carries customer name, phone and delivery address, so the
 * query key is principal-partitioned and the fetch is gated on
 * `canSensitive("fulfillment.print_label")` — the same capability the server
 * requires — read fail-closed. FulfillmentSensitiveCacheGuard evicts any cached
 * label PII the instant that capability stops holding.
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
  const queryClient = useQueryClient();
  // Fail-closed: canSensitive, not can — a pending/refresh-failed snapshot must
  // not fetch label PII, and this is the same key the server enforces.
  const canPrint = capabilities.canSensitive("fulfillment.print_label");
  // Correcting a destination needs orders.update (same server gate).
  const canConfirm = capabilities.can("orders.update");

  // Only the order id is held here — never the name/phone/address. The PII the
  // child sheet shows is re-derived from the (permission-gated) query result on
  // every render, so nothing sensitive is parked in component state.
  const [confirmOrderId, setConfirmOrderId] = useState<string | null>(null);

  // Revocation (or the dialog closing) drops the target immediately.
  useEffect(() => {
    if (!canPrint || !open) setConfirmOrderId(null);
  }, [canPrint, open]);

  const query = useQuery({
    // Principal-partitioned + sorted id set (see fulfillmentKeys.parcelLabels).
    queryKey: fulfillmentKeys.parcelLabels(userId, organizationId, orderIds),
    queryFn: () => Promise.all(orderIds.map((id) => getParcelLabelData(id))),
    enabled: open && orderIds.length > 0 && canPrint,
  });

  if (!open) return null;

  // Fail-closed: without the capability, never read whatever the observer still
  // holds — the label is treated as empty regardless of cache timing.
  const data: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
  const confirmTarget =
    canPrint && canConfirm && confirmOrderId
      ? (data.find((d) => d.order.id === confirmOrderId) ?? null)
      : null;
  const unconfirmed = data.filter((d) => !d.customer.addressConfirmed);
  const confirmed = data.filter((d) => d.customer.addressConfirmed);
  const allConfirmed = data.length > 0 && unconfirmed.length === 0;

  const title =
    orderIds.length > 1
      ? t("labels.parcel.bulkTitle", { count: orderIds.length })
      : t("labels.parcel.title");

  function evictAndRefetch() {
    // Drop the stale label PII and refetch so a just-confirmed order becomes
    // printable, and refresh the Ready-to-Pack queue it came from.
    void queryClient.invalidateQueries({
      queryKey: fulfillmentKeys.parcelLabelsPrefix(userId, organizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: fulfillmentKeys.readyToPack(userId, organizationId),
    });
  }

  return (
    <>
      <LabelSheet
        open={open}
        onClose={onClose}
        title={title}
        pageSize={PARCEL_LABEL_SIZE_MM}
        printable={canPrint && allConfirmed}
        active={confirmTarget === null}
        controls={
          canPrint && query.isSuccess && (unconfirmed.length > 0 || canConfirm) ? (
            <div className="space-y-2">
              {unconfirmed.length > 0 ? (
                <div>
                  <p className="text-label text-text-primary">
                    {t("labels.parcel.needsConfirmTitle")}
                  </p>
                  <p className="text-caption text-text-muted">
                    {unconfirmed.length === 1
                      ? t("labels.parcel.needsConfirmOne")
                      : t("labels.parcel.needsConfirmBody", { count: unconfirmed.length })}
                  </p>
                </div>
              ) : null}
              <ul className="space-y-1.5">
                {data
                  .filter((d) => !d.customer.addressConfirmed || canConfirm)
                  .map((d) => (
                    <li
                      key={d.order.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-border-default px-3 py-2"
                    >
                      <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
                        {d.order.orderNumber}
                      </span>
                      {canConfirm ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="tap-target h-9 shrink-0 rounded-xl"
                          onClick={() => setConfirmOrderId(d.order.id)}
                        >
                          {d.customer.addressConfirmed
                            ? t("labels.parcel.editCta")
                            : t("labels.parcel.confirmCta")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </div>
          ) : undefined
        }
      >
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
          // Only confirmed orders render as printable label pages. Unconfirmed
          // ones are surfaced in `controls` with a confirm action instead, and
          // the Print button stays hidden until every one is confirmed.
          confirmed.map((d) => <ParcelLabel key={d.order.id} vm={buildParcelLabel(d)} />)
        )}
      </LabelSheet>

      {confirmTarget ? (
        <ShippingDestinationSheet
          key={confirmTarget.order.id}
          open
          onOpenChange={(next) => {
            if (!next) setConfirmOrderId(null);
          }}
          orderId={confirmTarget.order.id}
          orderNumber={confirmTarget.order.orderNumber}
          initial={{
            name: confirmTarget.customer.name ?? "",
            phone: confirmTarget.customer.phone ?? "",
            address: confirmTarget.customer.address ?? "",
          }}
          editing={confirmTarget.customer.addressConfirmed}
          onSaved={() => {
            setConfirmOrderId(null);
            evictAndRefetch();
          }}
        />
      ) : null}
    </>
  );
}
