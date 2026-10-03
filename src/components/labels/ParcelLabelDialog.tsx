import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LabelSheet } from "./LabelSheet";
import { ParcelLabel } from "./ParcelLabel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/design-system";
import { ShippingDestinationSheet } from "@/components/orders/ShippingDestinationSheet";
import {
  reauthorizeCapability,
  useCapabilities,
  useSensitiveCapabilityRevalidation,
} from "@/hooks/use-capabilities";
import { getParcelLabelData } from "@/lib/api";
import { buildParcelLabel, PARCEL_LABEL_SIZE_MM } from "@/lib/labels/parcel-label";
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";
import { fulfillmentKeys } from "@/lib/fulfillment-query";

/**
 * SHIPPING label preview + print (§13, §17). Accepts one or many order ids; each
 * order prints as its own 100×150 mm page (§17 bulk print).
 *
 * ── SHIPPING LABEL VS APSA PARCEL LABEL (CORRECTION-003) ─────────────────────
 *
 * This is the carrier-facing label: carrier, tracking (Code 128), sender,
 * receiver, COD. It exists only for a carrier shipment — an order without one
 * is not printable and is told so. It never creates or changes the APSA
 * Parcel: the parcel ID appears as secondary text only. The scannable internal
 * identity is printed by InternalParcelLabelDialog, always available.
 *
 * A cancelled shipment is not printable (its carrier/tracking are void); the
 * replacement shipment prints a NEW shipping label with the SAME parcel ID.
 *
 * ── ORDER-AUTHORITATIVE DESTINATION (§9, §13, migration 047) ──────────────────
 *
 * A label's destination is the ORDER's shipping snapshot, never the mutable
 * customer default. An order whose snapshot is not confirmed
 * (addressConfirmed === false) is NOT printable.
 *
 * ── PII IS FAIL-CLOSED (§12) ──────────────────────────────────────────────────
 *
 * The label payload carries customer name, phone and delivery address, so the
 * query key is principal-partitioned and the fetch is gated on
 * `canSensitive("fulfillment.print_label")`.
 */
export interface ParcelLabelDialogProps {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
  userId: string;
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
  const canPrint = capabilities.canSensitive("fulfillment.print_label");
  const canConfirm = capabilities.can("orders.update");

  useSensitiveCapabilityRevalidation(userId, organizationId, open);

  const [confirmOrderId, setConfirmOrderId] = useState<string | null>(null);

  useEffect(() => {
    if (!canPrint || !open) setConfirmOrderId(null);
  }, [canPrint, open]);

  const query = useQuery({
    queryKey: fulfillmentKeys.parcelLabels(userId, organizationId, orderIds),
    queryFn: () => Promise.all(orderIds.map((id) => getParcelLabelData(id))),
    enabled: open && orderIds.length > 0 && canPrint,
  });

  if (!open) return null;

  async function reauthorizePrint(): Promise<boolean> {
    const ok = await reauthorizeCapability(
      queryClient,
      userId,
      organizationId,
      "fulfillment.print_label",
    );
    if (!ok) {
      setConfirmOrderId(null);
      const queryKey = fulfillmentKeys.parcelLabelsPrefix(userId, organizationId);
      void queryClient.cancelQueries({ queryKey }).catch(() => undefined);
      queryClient.removeQueries({ queryKey });
    }
    return ok;
  }

  /**
   * Pre-print hook: never print a shipping label without its carrier shipment
   * (the Print button is hidden in that case too), then reauthorize server-side.
   */
  async function handleBeforePrint(): Promise<boolean> {
    const currentData: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
    if (currentData.length === 0 || currentData.some((d) => d.delivery === null)) return false;
    return reauthorizePrint();
  }

  const data: ParcelLabelInput[] = canPrint ? (query.data ?? []) : [];
  const confirmTarget =
    canPrint && canConfirm && confirmOrderId
      ? (data.find((d) => d.order.id === confirmOrderId) ?? null)
      : null;
  const unconfirmed = data.filter((d) => !d.customer.addressConfirmed);
  const confirmed = data.filter((d) => d.customer.addressConfirmed);
  const allConfirmed = data.length > 0 && unconfirmed.length === 0;
  // A shipping label exists only for a carrier shipment (CORRECTION-003).
  const unshipped = data.filter((d) => d.delivery === null);
  const allShipped = data.length > 0 && unshipped.length === 0;

  const title =
    orderIds.length > 1
      ? t("labels.parcel.bulkTitle", { count: orderIds.length })
      : t("labels.parcel.title");

  function evictAndRefetch() {
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
        printable={canPrint && allConfirmed && allShipped}
        active={confirmTarget === null}
        onBeforePrint={handleBeforePrint}
        controls={
          canPrint && query.isSuccess ? (
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
              {unconfirmed.length > 0 || canConfirm ? (
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
              ) : null}
              {unshipped.length > 0 ? (
                <p role="status" className="text-caption text-text-muted">
                  {t("labels.parcel.needsDelivery")}
                </p>
              ) : null}
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
